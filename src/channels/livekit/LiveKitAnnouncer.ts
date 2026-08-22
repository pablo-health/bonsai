import { inject, singleton } from 'tsyringe';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index';
import { agents, providers, stages } from '../../db/schema';
import { TtsProviderFactory } from '../../services/providers/tts/TtsProviderFactory';
import { AudioConverterFactory } from '../../services/audio/AudioConverterFactory';
import type { AudioFormat } from '../../types/audio';
import { logger } from '../../utils/logger';

/**
 * Renders a short line of speech in the agent's own voice, outside the conversation.
 *
 * An announcement is not a conversational turn: it is addressed to one participant, it must not
 * enter the transcript, and it must not contend with the runner for the TTS session. So this
 * resolves the agent's configured voice and builds a **fresh, single-use** provider instance for
 * each line, rather than borrowing the one the runner is streaming through.
 *
 * Every failure path returns `null`. A caller uses that to skip the announcement and carry on -
 * losing the spoken line is a much smaller harm than dropping the call it was meant to introduce.
 */
@singleton()
export class LiveKitAnnouncer {
  constructor(@inject(TtsProviderFactory) private readonly ttsProviderFactory: TtsProviderFactory) {}

  /**
   * Synthesizes `text` in the agent's voice and returns raw PCM in `targetFormat`.
   *
   * @param projectId - Project owning the agent.
   * @param stageId - Stage the conversation runs in, used to find the agent when `agentId` is unset.
   * @param agentId - Agent whose voice to speak in. Falls back to the stage's agent.
   * @param text - The line to speak.
   * @param targetFormat - Format the audio is needed in, normally the room's publish format.
   * @returns The audio, or `null` when no voice is configured or synthesis failed.
   */
  async synthesize(
    projectId: string,
    stageId: string | undefined,
    agentId: string | undefined,
    text: string,
    targetFormat: AudioFormat,
  ): Promise<Buffer | null> {
    const agent = await this.resolveAgent(projectId, stageId, agentId);
    if (!agent?.ttsProviderId || !agent.ttsSettings) {
      logger.info({ projectId, stageId, agentId }, 'LiveKit: no voice configured for the agent, skipping the announcement');
      return null;
    }

    const providerEntity = await db.query.providers.findFirst({ where: eq(providers.id, agent.ttsProviderId) });
    if (!providerEntity) {
      logger.warn({ projectId, ttsProviderId: agent.ttsProviderId }, 'LiveKit: the agent TTS provider is missing, skipping the announcement');
      return null;
    }

    try {
      const tts = await this.ttsProviderFactory.createProvider(providerEntity, agent.ttsSettings);
      const chunks: Buffer[] = [];
      let failure: Error | null = null;

      tts.setOnSpeechGenerating(async (chunk) => {
        if (chunk.audio.length > 0) chunks.push(chunk.audio);
      });
      tts.setOnError(async (error) => {
        failure = error;
      });

      try {
        await tts.init();
        await tts.start();
        await tts.sendText(text);
        // end() flushes the buffered text, awaits every queued synthesis request and only then
        // fires generation-ended, so by the time it resolves `chunks` holds the whole line.
        await tts.end();
      } finally {
        await tts.cleanup();
      }

      if (failure) throw failure;
      if (chunks.length === 0) {
        logger.warn({ projectId, text }, 'LiveKit: the announcement synthesized to no audio');
        return null;
      }

      return await this.convert(Buffer.concat(chunks), tts.getOutputFormat(), targetFormat);
    } catch (error) {
      logger.error({ error, projectId, stageId, agentId }, 'LiveKit: failed to synthesize the announcement');
      return null;
    }
  }

  /**
   * Finds the agent to speak as, preferring an explicit id and otherwise the stage's own agent.
   * @param projectId - Project owning both records.
   * @param stageId - Stage to read `agentId` from when none was given.
   * @param agentId - Explicit agent id, when routing supplied one.
   */
  private async resolveAgent(projectId: string, stageId: string | undefined, agentId: string | undefined) {
    let id = agentId;

    if (!id && stageId) {
      const stage = await db.query.stages.findFirst({ where: and(eq(stages.projectId, projectId), eq(stages.id, stageId)) });
      id = stage?.agentId;
    }

    if (!id) return null;
    return db.query.agents.findFirst({ where: and(eq(agents.projectId, projectId), eq(agents.id, id)) });
  }

  /**
   * Runs a complete buffer through the shared converter pipeline.
   *
   * The converters are stream-shaped because the runner feeds them chunk by chunk as TTS arrives.
   * An announcement is short and already complete, so it is pushed in one go and drained on 'end'.
   * @param audio - The synthesized audio.
   * @param from - Format the TTS provider produced.
   * @param to - Format required by the destination.
   */
  private async convert(audio: Buffer, from: AudioFormat, to: AudioFormat): Promise<Buffer> {
    if (from === to) return audio;

    const converter = await AudioConverterFactory.create(from, to);
    const out: Buffer[] = [];

    try {
      const drained = new Promise<void>((resolve, reject) => {
        converter.on('data', (chunk) => out.push(chunk));
        converter.on('error', reject);
        converter.on('end', resolve);
      });

      converter.push(audio);
      converter.end();
      await drained;
    } finally {
      converter.destroy();
    }

    return Buffer.concat(out);
  }
}
