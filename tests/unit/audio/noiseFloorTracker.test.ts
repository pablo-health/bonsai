import 'reflect-metadata';
import { describe, it } from 'mocha';
import { expect } from 'chai';
import {
  NoiseFloorTracker, bandFor, publishNoise, noiseFor, forgetNoise,
  NOISE_HARD_RMS, NOISE_NOISY_RMS, NOISE_VAD_GATE, SILENCE_RMS, BAND_DWELL_BLOCKS,
} from '../../../src/services/audio/NoiseFloorTracker';

const RATE = 16000;
/** One 10 ms VAD frame of PCM16 at a given RMS: a square wave, whose RMS is its amplitude. */
function frame(rms: number): Buffer {
  const n = RATE / 100;
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(i % 2 === 0 ? rms : -rms, i * 2);
  return b;
}
/** Feed `seconds` of frames at `rms` with VAD probability `prob`. */
function feed(t: NoiseFloorTracker, seconds: number, rms: number, prob: number): void {
  for (let i = 0; i < seconds * 100; i++) t.push(prob, frame(rms));
}
/** A caller talking loudly for two seconds, so the below-caller-level gate has a level to work from. */
function caller(t: NoiseFloorTracker): void {
  feed(t, 2, 2000, 0.95);
}

describe('NoiseFloorTracker', () => {
  it('reads the room out of the frames the VAD says are not speech, and ignores the caller', () => {
    const t = new NoiseFloorTracker(RATE);
    caller(t);
    feed(t, 6, 30, 0.05);
    const s = t.state();
    expect(s.floorRms).to.equal(30);
    expect(s.speechRms).to.equal(2000);
    expect(s.band).to.equal('noisy');
    expect(s.snrDb).to.be.closeTo(36.5, 0.5);
  });

  it('treats near-silence as the codec not transmitting, never as the room', () => {
    const t = new NoiseFloorTracker(RATE);
    caller(t);
    feed(t, 3, 0, 0.0);
    feed(t, 3, SILENCE_RMS - 1, 0.0);
    expect(t.state().quietBlocks).to.equal(0);
    expect(t.state().band).to.equal('quiet');
    feed(t, 4, 40, 0.0);
    expect(t.state().floorRms).to.equal(40);
  });

  it('gates on the highest probability in a block, so a block touched by speech is not ambience', () => {
    const t = new NoiseFloorTracker(RATE);
    caller(t);
    // 500 ms blocks: 49 quiet frames then one at the gate in each block
    for (let block = 0; block < 10; block++) {
      for (let i = 0; i < 49; i++) t.push(0.01, frame(6));
      t.push(NOISE_VAD_GATE, frame(6));
    }
    expect(t.state().quietBlocks).to.equal(0);
  });

  it("does not count the caller's own residue: a VAD-quiet block near the caller's level is the caller", () => {
    const t = new NoiseFloorTracker(RATE);
    caller(t);
    feed(t, 4, 400, 0.05); // a fifth of the caller's level: a breath, an "um", the tail of a word
    expect(t.state().quietBlocks).to.equal(0);
  });

  it('classifies the corpus levels: quiet under 12, hard from 12, noisy from 16', () => {
    for (const [rms, band] of [[6, 'quiet'], [11, 'quiet'], [12, 'hard'], [14, 'hard'], [16, 'noisy'], [20, 'noisy']] as const) {
      const t = new NoiseFloorTracker(RATE);
      caller(t);
      feed(t, 6, rms, 0.05);
      expect(t.state().band, `rms ${rms}`).to.equal(band);
    }
  });

  it('waits out a short excursion before changing band', () => {
    const t = new NoiseFloorTracker(RATE);
    caller(t);
    feed(t, 6, 6, 0.05);
    expect(t.state().band).to.equal('quiet');
    // A short loud excursion - the quiet calls in the corpus do this - moves nothing: the median
    // over the window has to cross first, and then the band waits out BAND_DWELL_BLOCKS more.
    feed(t, (BAND_DWELL_BLOCKS - 1) * 0.5, 30, 0.05);
    expect(t.state().band).to.equal('quiet');
    // A room that stays loud for half the window and the dwell does move it.
    feed(t, 10, 30, 0.05);
    expect(t.state().band).to.equal('noisy');
  });

  it('forgets a room older than the window', () => {
    const t = new NoiseFloorTracker(RATE);
    caller(t);
    feed(t, 6, 40, 0.05);
    expect(t.state().band).to.equal('noisy');
    feed(t, 24, 5, 0.05); // the caller walked indoors
    expect(t.state().floorRms).to.equal(5);
    expect(t.state().band).to.equal('quiet');
  });
});

describe('bandFor', () => {
  it('steps up at the threshold and down only with hysteresis', () => {
    expect(bandFor('quiet', NOISE_HARD_RMS)).to.equal('hard');
    expect(bandFor('hard', NOISE_HARD_RMS - 1)).to.equal('hard');
    expect(bandFor('hard', NOISE_HARD_RMS - 3)).to.equal('quiet');
    expect(bandFor('hard', NOISE_NOISY_RMS)).to.equal('noisy');
    expect(bandFor('noisy', NOISE_NOISY_RMS - 1)).to.equal('noisy');
    expect(bandFor('noisy', NOISE_NOISY_RMS - 3)).to.equal('hard');
    expect(bandFor('noisy', 0)).to.equal('quiet');
  });
});

describe('noise registry', () => {
  it('publishes per conversation and forgets on teardown', () => {
    const state = { floorRms: 12, speechRms: 2000, snrDb: 44.4, band: 'hard' as const, quietBlocks: 9 };
    publishNoise('conv-a', state);
    expect(noiseFor('conv-a')).to.deep.equal(state);
    expect(noiseFor('conv-b')).to.equal(undefined);
    forgetNoise('conv-a');
    expect(noiseFor('conv-a')).to.equal(undefined);
  });
});
