import 'reflect-metadata';
import { describe, it } from 'mocha';
import { expect } from 'chai';
import {
  TranscribeAsrProvider,
  meanItemConfidence,
  transcribeAsrProviderConfigSchema,
  transcribeAsrSettingsSchema,
} from '../../../src/services/providers/asr/TranscribeAsrProvider';

/**
 * Exposes the base class's recognised-chunk hook so a turn can be simulated without a stream.
 * Nothing here reaches AWS: the SDK client is constructed but never sent a command.
 */
class TestableTranscribeAsrProvider extends TranscribeAsrProvider {
  recognize(text: string): void {
    this.handleRecognized('chunk_test', text);
  }
}

function makeProvider(): TestableTranscribeAsrProvider {
  return new TestableTranscribeAsrProvider(
    transcribeAsrProviderConfigSchema.parse({ region: 'us-east-1', accessKeyId: 'test', secretAccessKey: 'test' }),
    transcribeAsrSettingsSchema.parse({}),
  );
}

/**
 * getAllTextChunks() is specified as "recognised since the last start()", and the runner depends
 * on exactly that: at each end-of-utterance it takes the whole chunk list as the caller's turn.
 *
 * When this provider did not clear on start(), the previous turn's chunks came back on the next
 * one and the runner submitted the earlier sentence again as if freshly spoken. On a barged-in
 * call each replay opened another turn whose TTS cancelled the reply still being spoken, so the
 * agent interrupted itself and never finished a sentence. Observed on a live call to the demo
 * line on 2026-08-27: one utterance, submitted three times, three cancelled replies.
 */
describe('TranscribeAsrProvider turn isolation', () => {
  it('does not carry the previous turn\'s transcript into the next turn', async () => {
    const provider = makeProvider();

    await provider.start();
    provider.recognize('I know, I want to make an appointment.');
    expect(provider.getAllTextChunks().map((c) => c.text)).to.deep.equal(['I know, I want to make an appointment.']);
    await provider.stop();

    await provider.start();
    expect(provider.getAllTextChunks(), 'a new turn starts with no transcript').to.have.length(0);
    await provider.stop();

    await provider.cleanup();
  });

  it('keeps chunks within a single turn', async () => {
    const provider = makeProvider();

    await provider.start();
    provider.recognize('Thursday');
    provider.recognize('no, make it Friday');
    expect(provider.getAllTextChunks().map((c) => c.text)).to.deep.equal(['Thursday', 'no, make it Friday']);
    await provider.stop();

    await provider.cleanup();
  });
});

/**
 * Transcribe reports confidence per item and only on final results, so the value the noise gate
 * weighs has to be built here. Punctuation carries a confidence of its own that says nothing
 * about whether a word was heard, so it is excluded.
 */
describe('meanItemConfidence', () => {
  it('averages the spoken words and ignores punctuation', () => {
    const mean = meanItemConfidence([
      { Type: 'pronunciation', Confidence: 0.9 },
      { Type: 'pronunciation', Confidence: 0.7 },
      { Type: 'punctuation', Confidence: 0.0 },
    ]);
    expect(mean).to.be.closeTo(0.8, 0.0001);
  });

  it('is undefined when nothing carries a score, so the gate reads it as unknown', () => {
    expect(meanItemConfidence([{ Type: 'pronunciation' }])).to.equal(undefined);
    expect(meanItemConfidence([])).to.equal(undefined);
    expect(meanItemConfidence(undefined)).to.equal(undefined);
  });
});
