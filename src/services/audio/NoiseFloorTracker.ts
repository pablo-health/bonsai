/**
 * How loud the room is, measured while the caller is not talking.
 *
 * A phone call is one mixed stream, and nothing downstream can tell the caller from the room.
 * But the ROOM is there in the gaps between the caller's words, and its level is a signal the
 * runtime always has. This tracker is the fourth version of that idea; the first three each
 * failed on the 2026-08 corpus in a way worth writing down, because each looked right until it
 * was replayed against real calls:
 *
 * 1. DIGITAL SILENCE IS NOT THE ROOM. The handset's own noise suppression and the codec's
 *    discontinuous transmission send zeros - or dither of an RMS around 0.3 - between words on
 *    every call, concert included, for 40 to 70 percent of a recording. Any percentile that
 *    counts those reads "quiet" everywhere. Blocks under SILENCE_RMS are not transmission.
 * 2. THE CALLER'S OWN SPEECH CONTAMINATES A LEVEL TRACKER. Over all transmitted frames the
 *    lounge and the hotel read 14 and 12 at ten seconds, indistinguishable, and a quiet caller
 *    who hesitates - breaths, "um", the tails of words - reads 15 to 25 for the first twenty
 *    seconds. A level gate alone cannot tell that residue from ambience.
 * 3. THE VAD ALONE THROWS THE ROOM AWAY. Crowd babble IS speech, so FireRed scores it as speech
 *    and a VAD-only gate leaves nothing but dither: every concert read 0.3. That is the VAD
 *    behaving correctly, and it is why a speaker-agnostic detector can never answer "is this the
 *    caller" - the argument in docs/design/voice-noise-robustness.md, seen again here.
 *
 * What survives all three: a block counts toward the room only when it is transmitted
 * (above dither), the VAD calls it non-speech, AND it is well below the caller's own level.
 * Replayed through the production VAD (scripts/replay-noise.ts), the corpus then reads:
 *
 *   concert queue, three calls   15 - 20, reached after 28 to 54 seconds
 *   airport lounge               10 - 14, reached after 13 seconds
 *   hotel room, quiet            6,  with one false excursion to 12.5 in its second ten seconds
 *   quiet booking call           7 - 8, sitting at 11 for long stretches
 *
 * So the thresholds are MEASURED against this estimator, not chosen, and they are thin: a hard
 * call sits only 3 to 6 RMS above a quiet one. Two defences: a band changes only after the
 * floor has held past the threshold for BAND_DWELL_BLOCKS, which outlasts the quiet calls'
 * excursions, and it steps down only with hysteresis. Even so, this is a slow, coarse signal -
 * tens of seconds, not the first turn - and anything a prompt does with it should be something
 * a quiet caller would forgive if the band is wrong.
 *
 * What changes with the band is deliberately not here - it is prompt and intake configuration.
 * Quiet calls must pay nothing, so this tracker does no work beyond an RMS per 10 ms frame.
 */

export type NoiseBand = 'quiet' | 'hard' | 'noisy';

export interface NoiseState {
  /** Median RMS of the transmitted, VAD-quiet, below-caller-level blocks over the window. */
  floorRms: number;
  /** 90th percentile RMS of all transmitted blocks in the window: how loud the caller is. */
  speechRms: number;
  /** Speech over floor, in dB. */
  snrDb: number;
  band: NoiseBand;
  /** Blocks that went into the floor. Zero means the room has not been heard yet. */
  quietBlocks: number;
}

/**
 * Floor at or above this is a hard call. The lounge measured 10 - 14 and the quiet rooms 6 - 8,
 * but one quiet, hesitant caller sat at 11 for most of a call, so 10 flapped him between bands.
 * 12 keeps him quiet and recognises the lounge later (about 38 s in, not 15) - the right trade,
 * because a quiet caller treated as a noisy one is the mistake that costs the most.
 */
export const NOISE_HARD_RMS = 12;
/** Floor at or above this is a noisy call: the concert measured 15 - 20. */
export const NOISE_NOISY_RMS = 16;
/** A band steps down only once the floor is this far below its threshold. */
const HYSTERESIS_RMS = 2;
/** Blocks the floor must hold past a threshold before the band follows it: 3 s at 500 ms. */
export const BAND_DWELL_BLOCKS = 6;
/** A frame with VAD probability at or above this is speech, and does not count toward the room. */
export const NOISE_VAD_GATE = 0.2;
/** Below this RMS a block is the codec not transmitting (dither around zero), not the room. */
export const SILENCE_RMS = 2;
/** A block louder than this fraction of the caller's level is the caller, whatever the VAD said. */
const BELOW_CALLER_FRACTION = 0.1;
const BLOCK_MS = 500;
const WINDOW_BLOCKS = 40; // twenty seconds of 500 ms blocks
const FLOOR_PERCENTILE = 0.5;
const SPEECH_PERCENTILE = 0.9;

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

export class NoiseFloorTracker {
  private readonly blockSamples: number;
  private sumSquares = 0;
  private samples = 0;
  private maxProb = 0;
  private readonly allBlocks: number[] = [];
  private readonly quietBlocks: number[] = [];
  private band: NoiseBand = 'quiet';
  private candidate: NoiseBand = 'quiet';
  private candidateBlocks = 0;
  private cached: NoiseState | null = null;

  constructor(sampleRate: number) {
    this.blockSamples = Math.round((sampleRate * BLOCK_MS) / 1000);
  }

  /**
   * One VAD frame: its speech probability and its 16-bit little-endian PCM.
   * @returns true when a block closed and the state moved on.
   */
  push(probability: number, pcm16: Buffer): boolean {
    const n = pcm16.length >> 1;
    for (let i = 0; i < n; i++) {
      const s = pcm16.readInt16LE(i * 2);
      this.sumSquares += s * s;
    }
    this.samples += n;
    if (probability > this.maxProb) this.maxProb = probability;
    if (this.samples < this.blockSamples) return false;

    const rms = Math.sqrt(this.sumSquares / this.samples);
    const vadQuiet = this.maxProb < NOISE_VAD_GATE;
    this.sumSquares = 0;
    this.samples = 0;
    this.maxProb = 0;

    if (rms >= SILENCE_RMS) {
      this.allBlocks.push(rms);
      if (this.allBlocks.length > WINDOW_BLOCKS) this.allBlocks.shift();
      if (vadQuiet && rms < percentile(this.allBlocks, SPEECH_PERCENTILE) * BELOW_CALLER_FRACTION) {
        this.quietBlocks.push(rms);
        if (this.quietBlocks.length > WINDOW_BLOCKS) this.quietBlocks.shift();
      }
    }

    // The band follows the floor only once the floor has held there for a dwell.
    const wanted = bandFor(this.band, percentile(this.quietBlocks, FLOOR_PERCENTILE));
    if (wanted === this.band) {
      this.candidate = this.band;
      this.candidateBlocks = 0;
    } else if (wanted === this.candidate) {
      this.candidateBlocks += 1;
      if (this.candidateBlocks >= BAND_DWELL_BLOCKS) {
        this.band = wanted;
        this.candidateBlocks = 0;
      }
    } else {
      this.candidate = wanted;
      this.candidateBlocks = 1;
    }
    this.cached = null;
    return true;
  }

  state(): NoiseState {
    if (this.cached) return this.cached;
    const floorRms = percentile(this.quietBlocks, FLOOR_PERCENTILE);
    const speechRms = percentile(this.allBlocks, SPEECH_PERCENTILE);
    const snrDb = floorRms > 0 && speechRms > 0 ? 20 * Math.log10(speechRms / floorRms) : 0;
    this.cached = {
      floorRms: Math.round(floorRms * 10) / 10,
      speechRms: Math.round(speechRms),
      snrDb: Math.round(snrDb * 10) / 10,
      band: this.band,
      quietBlocks: this.quietBlocks.length,
    };
    return this.cached;
  }
}

/** The band a floor asks for, given the current one: up at the threshold, down with hysteresis. */
export function bandFor(current: NoiseBand, floorRms: number): NoiseBand {
  if (floorRms >= NOISE_NOISY_RMS) return 'noisy';
  if (current === 'noisy' && floorRms >= NOISE_NOISY_RMS - HYSTERESIS_RMS) return 'noisy';
  if (floorRms >= NOISE_HARD_RMS) return 'hard';
  if (current !== 'quiet' && floorRms >= NOISE_HARD_RMS - HYSTERESIS_RMS) return 'hard';
  return 'quiet';
}

/**
 * The latest state per live conversation, for readers that have a conversation id and nothing
 * else - the template context builder in particular, which works from the database record and
 * never sees the runner. The runner publishes after each block and forgets on teardown.
 */
const registry = new Map<string, NoiseState>();

export function publishNoise(conversationId: string, state: NoiseState): void {
  registry.set(conversationId, state);
}

export function noiseFor(conversationId: string): NoiseState | undefined {
  return registry.get(conversationId);
}

export function forgetNoise(conversationId: string): void {
  registry.delete(conversationId);
}
