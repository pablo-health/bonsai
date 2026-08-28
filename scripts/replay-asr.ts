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

  // Delivery shape is a variable, not a detail. Live audio arrives from LiveKit as small frames
  // with network jitter; a replay that pushes big regular chunks is not reproducing the live
  // conditions, it is giving the recogniser an easier problem. Transcribe segments on timing and
  // commits partial hypotheses early, so this can change the transcript.
  const frameMs = Number(arg('frame-ms') ?? CHUNK_MS);
  const jitterMs = Number(arg('jitter-ms') ?? 0);
  const gapEveryMs = Number(arg('gap-every-ms') ?? 0);
  const gapMs = Number(arg('gap-ms') ?? 0);
  const frameBytes = Math.max(2, Math.round((SAMPLE_RATE * BYTES_PER_SAMPLE * frameMs) / 1000) & ~1);

  // Deterministic pseudo-jitter: a replay that varies run to run cannot be compared against
  // itself, and Math.random would make every sweep a different experiment.
  let seed = 12345;
  const rand = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  let elapsedMs = 0;
  let sinceGapMs = 0;
  for (let at = 0; at < audio.length; at += frameBytes) {
    await provider.sendAudio(audio.subarray(at, Math.min(at + frameBytes, audio.length)));

    let waitMs = frameMs + (jitterMs ? (rand() * 2 - 1) * jitterMs : 0);
    if (waitMs < 0) waitMs = 0;

    sinceGapMs += frameMs;
    if (gapEveryMs && gapMs && sinceGapMs >= gapEveryMs) {
      // A starved queue, which is what a real gap looks like from the provider's side: it stops
      // being fed, and past its keepalive interval it starts inserting silence of its own.
      waitMs += gapMs;
      sinceGapMs = 0;
    }

    elapsedMs += waitMs;
    await new Promise((r) => setTimeout(r, waitMs));
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
    frameMs, jitterMs, gapEveryMs, gapMs,
    seconds: Number((audio.length / (SAMPLE_RATE * BYTES_PER_SAMPLE)).toFixed(2)),
    heard: text,
    meanConfidence: mean === undefined ? null : Number(mean.toFixed(3)),
  }));

  await provider.cleanup();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
