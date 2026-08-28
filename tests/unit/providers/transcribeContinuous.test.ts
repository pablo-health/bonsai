import { expect } from 'chai';
import {
  TranscribeAsrProvider,
  transcribeAsrProviderConfigSchema,
  transcribeAsrSettingsSchema,
} from '../../../src/services/providers/asr/TranscribeAsrProvider';

/**
 * These exercise the SESSION LIFECYCLE only, and deliberately never send audio - the Transcribe
 * stream is opened lazily on the first frame, so everything below runs without AWS.
 *
 * The lifecycle is the whole change. Recognition quality is not a unit-testable property; it was
 * measured against the recorded corpus instead, and what these pin down is the thing that measurement
 * depends on: that a turn boundary no longer tears the session down and builds a new one.
 */
function makeProvider(continuousStream: boolean): TranscribeAsrProvider {
  return new TranscribeAsrProvider(
    transcribeAsrProviderConfigSchema.parse({ region: 'us-east-1' }),
    transcribeAsrSettingsSchema.parse({ audioFormat: 'pcm_16000', language: 'en-US', continuousStream }),
  );
}

describe('TranscribeAsrProvider continuous stream', () => {
  describe('with continuousStream on', () => {
    it('starts the session once however many turns there are', async () => {
      const provider = makeProvider(true);
      let started = 0;
      provider.setOnRecognitionStarted(() => { started++; });

      await provider.start();
      await provider.stop();
      await provider.start();
      await provider.stop();
      await provider.start();

      expect(started).to.equal(1);
    });

    it('ends every turn, so the runner is still driven onward each time', async () => {
      // handleRecognitionStopped is what drives processUserInput. If ending a turn stopped firing
      // it, the caller would speak and the agent would never answer - which is the failure mode
      // this whole area keeps producing, so it is worth an explicit test.
      const provider = makeProvider(true);
      let stopped = 0;
      provider.setOnRecognitionStopped(() => { stopped++; });

      await provider.start();
      await provider.stop();
      await provider.start();
      await provider.stop();

      expect(stopped).to.equal(2);
    });

    it('gives each turn its own transcript, not the previous turn as well', async () => {
      const provider = makeProvider(true);
      await provider.start();
      (provider as unknown as { handleRecognized(id: string, text: string): void })
        .handleRecognized('chunk_1', 'my name is Kurt');
      expect(provider.getAllTextChunks()).to.have.length(1);

      await provider.stop();
      await provider.start();

      // The bug this guards is real and has shipped: start() once failed to clear the chunk list,
      // so the runner replayed the previous sentence as a new utterance and the agent talked over
      // itself.
      expect(provider.getAllTextChunks()).to.have.length(0);
    });

    it('promotes an unfinalised partial ONLY when the turn would otherwise be empty', async () => {
      // Measured over six turns of a replay: four ended cleanly on finals, one ended with a final
      // AND a partial, one ended with ONLY a partial. Promoting unconditionally duplicated the
      // middle case into the next turn; never promoting would have left the last case empty, and
      // an empty turn is the agent telling a caller who was speaking that it did not catch them.
      const provider = makeProvider(true);
      const asInternals = provider as unknown as { lastPartial: string; handleRecognized(id: string, t: string): void };

      // A turn that already has words: the partial is dropped rather than added on top.
      await provider.start();
      asInternals.handleRecognized('chunk_1', 'my name is Kurt');
      asInternals.lastPartial = 'my name is Kurt';
      await provider.stop();
      expect(provider.getAllTextChunks().map(c => c.text)).to.deep.equal(['my name is Kurt']);

      // A turn with nothing else: the partial is the only record of what was said, so it is kept.
      await provider.start();
      asInternals.lastPartial = "it's Kurt";
      await provider.stop();
      expect(provider.getAllTextChunks().map(c => c.text)).to.deep.equal(["it's Kurt"]);
    });

    it('does not carry a discarded partial into the next turn', async () => {
      const provider = makeProvider(true);
      const asInternals = provider as unknown as { lastPartial: string; handleRecognized(id: string, t: string): void };

      await provider.start();
      asInternals.handleRecognized('chunk_1', 'my name is Kurt');
      asInternals.lastPartial = 'stale';
      await provider.stop();

      await provider.start();
      await provider.stop();
      expect(provider.getAllTextChunks()).to.have.length(0);
    });

    it('is still able to accept audio after a turn ends', async () => {
      // The point of the mode: a turn boundary must not stop the recogniser listening. sendAudio
      // silently discards frames when the session is not recognising, so a provider that shut
      // itself down at end of turn would look fine and quietly hear nothing.
      const provider = makeProvider(true);
      await provider.start();
      await provider.stop();
      expect((provider as unknown as { isRecognizing: boolean }).isRecognizing).to.equal(true);
    });

    it('really does shut down on cleanup', async () => {
      const provider = makeProvider(true);
      await provider.start();
      await provider.cleanup();
      expect((provider as unknown as { isRecognizing: boolean }).isRecognizing).to.equal(false);
    });
  });

  describe('with continuousStream off, which is the default', () => {
    it('starts a fresh session for every turn, exactly as before', async () => {
      const provider = makeProvider(false);
      let started = 0;
      provider.setOnRecognitionStarted(() => { started++; });

      await provider.start();
      await provider.stop();
      await provider.start();

      expect(started).to.equal(2);
    });

    it('stops recognising at the end of a turn, exactly as before', async () => {
      const provider = makeProvider(false);
      await provider.start();
      await provider.stop();
      expect((provider as unknown as { isRecognizing: boolean }).isRecognizing).to.equal(false);
    });
  });
});
