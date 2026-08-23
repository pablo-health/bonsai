import { expect } from 'chai';
import { pcmToAudioFrames } from '../../../src/channels/livekit/LiveKitConnection';

/** PCM16LE buffer of `samples` samples, values irrelevant to framing. */
function pcm(samples: number): Buffer {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE((i % 1000) - 500, i * 2);
  return b;
}

describe('pcmToAudioFrames', () => {
  it('splits a burst into frames the transport will accept', () => {
    // 4.8 seconds in one buffer, the largest chunk observed from a streaming TTS vendor. Handed
    // over whole it is rejected with a bare InvalidState and the rest of the sentence is lost.
    const frames = [...pcmToAudioFrames(pcm(77461), 16000)];
    expect(frames.length).to.be.greaterThan(200);
    for (const f of frames) {
      expect(f.samplesPerChannel).to.be.at.most(320); // 20ms at 16kHz
      expect(f.sampleRate).to.equal(16000);
    }
  });

  it('preserves every sample across the split', () => {
    const total = [...pcmToAudioFrames(pcm(1000), 16000)]
      .reduce((n, f) => n + f.samplesPerChannel, 0);
    expect(total).to.equal(1000);
  });

  it('keeps the remainder rather than truncating to whole frames', () => {
    // 325 samples is one full 20ms frame plus 5. Dropping the tail would clip the end of every
    // utterance by up to 20ms, which is inaudible once and obvious over a call.
    const frames = [...pcmToAudioFrames(pcm(325), 16000)];
    expect(frames.length).to.equal(2);
    expect(frames[1].samplesPerChannel).to.equal(5);
  });

  it('scales the frame with the sample rate, not with a fixed sample count', () => {
    const frames = [...pcmToAudioFrames(pcm(2400), 24000)];
    expect(frames[0].samplesPerChannel).to.equal(480); // still 20ms
  });

  it('yields nothing for an empty buffer', () => {
    expect([...pcmToAudioFrames(Buffer.alloc(0), 16000)]).to.have.length(0);
  });

  it('ignores a trailing odd byte rather than reading past the end', () => {
    const odd = Buffer.concat([pcm(10), Buffer.from([0x7f])]);
    const total = [...pcmToAudioFrames(odd, 16000)]
      .reduce((n, f) => n + f.samplesPerChannel, 0);
    expect(total).to.equal(10);
  });
});
