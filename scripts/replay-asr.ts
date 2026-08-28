/**
 * Streams a recorded call's raw PCM through the real ASR provider and prints what it heard.
 *
 * The point is to stop paying for a phone call every time a setting changes. Everything about
 * recognition - the provider, its settings, a custom vocabulary - can be varied against the same
 * audio and compared, which is the difference between measuring a change and forming an
 * impression of one.
 *
 * This is deliberately the PRODUCTION provider rather than a copy of it, so what it reports is
 * what a call would have got. It is also the first piece of the replay harness in THERAPY-52xxe.
 *
 * Audio is fed at wall-clock speed on purpose. Transcribe's partial and endpoint behaviour is
 * timing-dependent, and pushing frames as fast as they can be read changes the answer.
 *
 * Usage:
 *   tsx scripts/replay-asr.ts --file call.raw [--offset BYTES] [--length BYTES]
 *                             [--vocabulary NAME] [--label TEXT]
 */
import { promises as fs } from 'fs';
import { TranscribeAsrProvider, transcribeAsrProviderConfigSchema, transcribeAsrSettingsSchema }
  from '../src/services/providers/asr/TranscribeAsrProvider';

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
/** 100ms of audio per push - close to what the LiveKit channel delivers. */
const CHUNK_BYTES = (SAMPLE_RATE * BYTES_PER_SAMPLE) / 10;
const CHUNK_MS = 100;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const file = arg('file');
  if (!file) throw new Error('--file is required');

  const offset = Number(arg('offset') ?? 0);
  const vocabulary = arg('vocabulary');
  const label = arg('label') ?? (vocabulary ?? 'open-vocabulary');

  const whole = await fs.readFile(file);
  const length = Number(arg('length') ?? (whole.length - offset));
  const audio = whole.subarray(offset, offset + length);

  const provider = new TranscribeAsrProvider(
    transcribeAsrProviderConfigSchema.parse({ region: process.env.AWS_REGION ?? 'us-east-1' }),
    transcribeAsrSettingsSchema.parse({
      audioFormat: 'pcm_16000',
      language: 'en-US',
      interimResults: true,
      partialResultsStability: 'medium',
      ...(vocabulary ? { vocabularyName: vocabulary } : {}),
    }),
  );

  await provider.init();
  await provider.start();

  for (let at = 0; at < audio.length; at += CHUNK_BYTES) {
    await provider.sendAudio(audio.subarray(at, Math.min(at + CHUNK_BYTES, audio.length)));
    await new Promise((r) => setTimeout(r, CHUNK_MS));
  }

  await provider.stop();
  const text = provider.getAllTextChunks().map((c) => c.text).join(' ').trim();
  const scored = provider.getAllTextChunks().filter((c) => typeof c.confidence === 'number');
  const mean = scored.length
    ? scored.reduce((t, c) => t + (c.confidence as number), 0) / scored.length
    : undefined;

  console.log(JSON.stringify({
    label,
    vocabulary: vocabulary ?? null,
    seconds: Number((audio.length / (SAMPLE_RATE * BYTES_PER_SAMPLE)).toFixed(2)),
    heard: text,
    meanConfidence: mean === undefined ? null : Number(mean.toFixed(3)),
  }));

  await provider.cleanup();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
