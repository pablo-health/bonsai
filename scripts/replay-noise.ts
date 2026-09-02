/**
 * Runs a recorded call's caller audio through the production VAD and the noise-floor tracker,
 * and prints the band timeline: what the runtime would have known about the room, and when.
 *
 * replay-vad answers "where would the gate have opened"; this answers "how loud was the room in
 * the gaps, as measured through the same VAD gating the runtime uses". Fed at wall-clock speed
 * for the same reason replay-vad is: FireRed's inference runs on a promise chain behind push(),
 * and feeding faster than real time would let the byte counter run ahead of the decisions.
 *
 * Usage:
 *   tsx scripts/replay-noise.ts --file call.raw [--label TEXT] [--every 5]
 *
 * Prints one JSON object with the state at each --every seconds and the final state, so a
 * corpus can be run through it and compared row by row.
 */
import { promises as fs } from 'fs';
import { VadProcessor } from '../src/services/audio/VadProcessor';
import { NoiseFloorTracker, type NoiseState } from '../src/services/audio/NoiseFloorTracker';

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const CHUNK_MS = 100;
const CHUNK_BYTES = (SAMPLE_RATE * BYTES_PER_SAMPLE * CHUNK_MS) / 1000;
const SETTLE_MS = 1000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const file = arg('file');
  if (!file) throw new Error('--file is required');
  const every = Number(arg('every') ?? 5);
  const label = arg('label') ?? file.split('/').slice(-2)[0];

  const audio = await fs.readFile(file);
  // The config live on the demo line: what the runtime would actually have seen.
  const vad = new VadProcessor(SAMPLE_RATE, {
    algorithm: 'firered', speechThreshold: 0.85, minSpeechFrame: 15, minSilenceFrame: 50, smoothWindowSize: 5,
  });
  await vad.init();

  const tracker = new NoiseFloorTracker(SAMPLE_RATE);
  let fedBytes = 0;
  const atSec = () => fedBytes / (SAMPLE_RATE * BYTES_PER_SAMPLE);
  const timeline: Array<{ sec: number } & NoiseState> = [];
  let nextReport = every;
  let bandChanges: Array<{ sec: number; band: string }> = [];
  let lastBand = 'quiet';

  vad.on('frame', (probability: number, frame: Buffer) => {
    if (!tracker.push(probability, frame)) return;
    const s = tracker.state();
    if (s.band !== lastBand) { bandChanges.push({ sec: Number(atSec().toFixed(1)), band: s.band }); lastBand = s.band; }
    if (atSec() >= nextReport) { timeline.push({ sec: nextReport, ...s }); nextReport += every; }
  });

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < audio.length; i += CHUNK_BYTES) {
    const chunk = audio.subarray(i, Math.min(i + CHUNK_BYTES, audio.length));
    vad.push(Buffer.from(chunk));
    fedBytes += chunk.length;
    await sleep(CHUNK_MS);
  }
  await sleep(SETTLE_MS);
  vad.destroy();

  console.log(JSON.stringify({
    label,
    seconds: Number((audio.length / (SAMPLE_RATE * BYTES_PER_SAMPLE)).toFixed(1)),
    final: tracker.state(),
    bandChanges,
    timeline,
  }));
}

main().catch((error) => { console.error(error); process.exit(1); });
