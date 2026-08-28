import { expect } from 'chai';
import { proximityFeatures, isNearField, NEAR_FIELD_TILT_THRESHOLD } from '../../../src/services/audio/proximity';

const SAMPLE_RATE = 16000;

/**
 * Synthesises a stretch of PCM with energy concentrated in one part of the telephone band.
 *
 * Real corpus audio cannot live in a unit test - it is a recording of a real person and it is
 * megabytes - so what is asserted here is the physics the detector rests on: a near talker is
 * low-band dominated and a room is not. The threshold itself is pinned to the corpus measurement
 * recorded in the module header, which is where an empirical claim belongs.
 */
function tone(hz: number, ms: number, amplitude = 0.3): Buffer {
  const samples = Math.round((SAMPLE_RATE * ms) / 1000);
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    // A slow amplitude wobble, so the segment has an envelope rather than being a pure sine: a
    // constant tone has no onsets at all, and is not what either a voice or a room looks like.
    const wobble = 0.7 + 0.3 * Math.sin((2 * Math.PI * 4 * i) / SAMPLE_RATE);
    const s = Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) * amplitude * wobble;
    buffer.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  return buffer;
}

/** Sums two buffers, clipping the way a real mix would. */
function mix(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(Math.min(a.length, b.length));
  for (let i = 0; i < out.length / 2; i++) {
    const s = a.readInt16LE(i * 2) + b.readInt16LE(i * 2);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, s)), i * 2);
  }
  return out;
}

describe('proximity', () => {
  it('reports positive tilt for low-band-dominated audio, which is what a near talker is', () => {
    const features = proximityFeatures(tone(400, 1200), SAMPLE_RATE);
    expect(features.spectralTilt).to.be.greaterThan(0);
    expect(features.activeFrames).to.be.greaterThan(20);
  });

  it('reports negative tilt for high-band-dominated audio, which is what a room is', () => {
    const features = proximityFeatures(tone(2800, 1200), SAMPLE_RATE);
    expect(features.spectralTilt).to.be.lessThan(NEAR_FIELD_TILT_THRESHOLD);
  });

  it('calls the low-band case near and the high-band case not', () => {
    expect(isNearField(tone(400, 1200), SAMPLE_RATE)).to.equal(true);
    expect(isNearField(tone(2800, 1200), SAMPLE_RATE)).to.equal(false);
  });

  it('still finds a near talker underneath a room, since that is the whole situation', () => {
    expect(isNearField(mix(tone(400, 1200), tone(2600, 1200, 0.12)), SAMPLE_RATE)).to.equal(true);
  });

  it('answers UNKNOWN rather than "the room" when there is not enough to judge', () => {
    // The distinction is load-bearing. A false "that was the room" while the agent is waiting for
    // a caller's name is precisely the failure this work exists to remove, so too-short and
    // too-quiet must never fall through to a rejection.
    expect(isNearField(tone(400, 30), SAMPLE_RATE)).to.equal(null);
    expect(isNearField(Buffer.alloc(0), SAMPLE_RATE)).to.equal(null);
  });

  it('does not simply restate loudness', () => {
    // Same spectrum, eight times the amplitude. A phone's automatic gain control moves level
    // constantly, so a feature that tracked level would be reporting the handset, not the speaker.
    const quiet = proximityFeatures(tone(400, 1200, 0.05), SAMPLE_RATE);
    const loud = proximityFeatures(tone(400, 1200, 0.4), SAMPLE_RATE);
    expect(Math.abs(quiet.spectralTilt - loud.spectralTilt)).to.be.lessThan(0.2);
  });
});
