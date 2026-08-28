/**
 * Runs a recorded call's audio through the production VAD and prints where it would have opened
 * a turn.
 *
 * The other two instruments answer "what could the recogniser do with this audio" (replay-asr)
 * and "what does the whole runtime do with this audio" (replay-live). Neither answers the
 * question underneath both of them: was the recogniser ever handed the audio at all.
 *
 * On a phone line the VAD is the gate. Nothing reaches Transcribe until `speech_start` fires, so
 * a threshold tuned in a concert queue can silently withhold a caller's entire answer while every
 * log line, every recording and every transcript looks like a caller who said nothing. That is
 * exactly what happened on 2026-08-28 in an airport lounge: the caller said his name five times,
 * the recogniser was fed zero bytes across three turns, and the call recorded three `[silence]`s.
 *
 * This is deliberately the production VadProcessor with the production FireRed config, so a
 * threshold can be varied against real audio and the result compared, rather than dialled in and
 * hoped for.
 *
 * Usage:
 *   tsx scripts/replay-vad.ts --file call.raw [--speech-threshold 0.85] [--min-speech-frame 30]
 *                             [--min-silence-frame 80] [--smooth-window 5] [--label TEXT]
 */
import { promises as fs } from 'fs';
import { VadProcessor } from '../src/services/audio/VadProcessor';
import { proximityFeatures } from '../src/services/audio/proximity';

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
/** 100ms per push - what the LiveKit channel delivers, and what receiveUserVoiceData sees. */
const CHUNK_MS = 100;
const CHUNK_BYTES = (SAMPLE_RATE * BYTES_PER_SAMPLE * CHUNK_MS) / 1000;
/** Time allowed for the inference chain to drain after the last frame is pushed. */
const SETTLE_MS = 1000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function num(name: string, fallback: number): number {
  const v = arg(name);
  return v === undefined ? fallback : Number(v);
}

/**
 * A stretch of audio the VAD would have let through to the recogniser, with what its acoustics
 * say about how far away the source was standing.
 */
type Segment = {
  startMs: number; endMs: number; durationMs: number;
  spectralTilt: number; modulationDepth: number; onsetSharpness: number; activeFrames: number;
};

async function main(): Promise<void> {
  const file = arg('file');
  if (!file) throw new Error('--file is required');

  // Defaults are the values live on the gateway box as at 2026-08-28, not the library defaults,
  // so a bare run reports what a caller actually met.
  const config = {
    algorithm: 'firered' as const,
    speechThreshold: num('speech-threshold', 0.85),
    minSpeechFrame: num('min-speech-frame', 30),
    minSilenceFrame: num('min-silence-frame', 80),
    smoothWindowSize: num('smooth-window', 5),
  };
  const label = arg('label') ?? `thr${config.speechThreshold}/min${config.minSpeechFrame}`;

  const whole = await fs.readFile(file);
  const offset = Number(arg('offset') ?? 0);
  const audio = whole.subarray(offset, offset + Number(arg('length') ?? whole.length - offset));

  const vad = new VadProcessor(SAMPLE_RATE, config);
  await vad.init();

  // Position is tracked in bytes fed, not wall clock. FireRed is frame-synchronous and its
  // decisions do not depend on how fast frames arrive, so the audio timeline is the honest one -
  // and it is the timeline the AsrFeedTap markers use, which is what makes the two comparable.
  let fedBytes = 0;
  const segments: Segment[] = [];
  let openedAtMs: number | null = null;
  const atMs = () => Math.round((fedBytes / (SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1000);

  vad.on('speech_start', () => { openedAtMs = atMs(); });
  vad.on('end_of_utterance', () => {
    if (openedAtMs === null) return;
    const endMs = atMs();
    // Measured from the file rather than from the VAD's own utterance buffer, so the window is
    // exactly the stretch reported above and the two numbers cannot drift apart.
    const bytesPerMs = (SAMPLE_RATE * BYTES_PER_SAMPLE) / 1000;
    const slice = audio.subarray(Math.round(openedAtMs * bytesPerMs), Math.round(endMs * bytesPerMs));
    const features = proximityFeatures(Buffer.from(slice), SAMPLE_RATE);
    segments.push({
      startMs: openedAtMs, endMs, durationMs: endMs - openedAtMs,
      spectralTilt: Number(features.spectralTilt.toFixed(3)),
      modulationDepth: Number(features.modulationDepth.toFixed(3)),
      onsetSharpness: Number(features.onsetSharpness.toFixed(3)),
      activeFrames: features.activeFrames,
    });
    openedAtMs = null;
  });

  // Fed at wall-clock speed, like replay-asr. FireRed's decisions are frame-synchronous and do
  // not depend on arrival rate, but its inference runs on a promise chain behind the push - so
  // feeding as fast as the file can be read would let that chain fall arbitrarily far behind the
  // byte counter, and every reported timestamp would be a lie about where the gate opened.
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < audio.length; i += CHUNK_BYTES) {
    const chunk = audio.subarray(i, Math.min(i + CHUNK_BYTES, audio.length));
    vad.push(Buffer.from(chunk));
    fedBytes += chunk.length;
    await sleep(CHUNK_MS);
  }
  // Let the inference chain finish the frames already queued. Deliberately NOT flush(): flush
  // force-emits a speech start the model had not committed to, which would invent a turn here.
  await sleep(SETTLE_MS);
  vad.destroy();

  // An utterance still open when the audio runs out is reported rather than dropped: a gate that
  // opened and never closed is a different fault from one that never opened.
  const unterminated = openedAtMs !== null ? { startMs: openedAtMs, endMs: null } : null;

  const speechMs = segments.reduce((sum, s) => sum + s.durationMs, 0);
  console.log(JSON.stringify({
    label,
    config,
    seconds: Number((audio.length / (SAMPLE_RATE * BYTES_PER_SAMPLE)).toFixed(2)),
    turnsOpened: segments.length + (unterminated ? 1 : 0),
    speechSeconds: Number((speechMs / 1000).toFixed(2)),
    segments,
    ...(unterminated ? { unterminated } : {}),
  }));
}

main().catch((error) => { console.error(error); process.exit(1); });
