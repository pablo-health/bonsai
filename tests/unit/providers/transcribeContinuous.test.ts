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

    it('WAITS for an outstanding final rather than taking the partial', async () => {
      // A partial is a latency affordance, not the truth. On a stream that never closes the final
      // is coming whether or not we are still listening, and taking a guess when the truth is
      // moments away is how the same words ended up in two turns at once.
      const provider = makeProvider(true);
      const asInternals = provider as unknown as {
        lastPartial: string;
        handleRecognized(id: string, t: string): void;
        finalArrived: (() => void) | null;
      };

      await provider.start();
      asInternals.lastPartial = "it's Kur";

      const stopped = provider.stop();
      // The final lands while the turn is holding on for it, which is the ordinary case.
      await new Promise((r) => setTimeout(r, 10));
      asInternals.lastPartial = '';
      asInternals.handleRecognized('chunk_final', "it's Kurt");
      asInternals.finalArrived?.();
      await stopped;

      expect(provider.getAllTextChunks().map((c) => c.text)).to.deep.equal(["it's Kurt"]);
    });

    it('falls back to the partial when no final arrives, rather than hanging the turn', async () => {
      // THE DEADLINE IS THE POINT. A final that never comes - a stream error, or a segment
      // Transcribe decides was not speech - must not hold the turn open forever, because an agent
      // that never speaks is indistinguishable from a dropped call. Four bugs in this system have
      // been a suppression path with no exit; an unbounded wait here would be the fifth.
      const provider = makeProvider(true);
      const asInternals = provider as unknown as { lastPartial: string };

      await provider.start();
      asInternals.lastPartial = "it's Kurt";

      const startedAt = Date.now();
      await provider.stop();

      expect(provider.getAllTextChunks().map((c) => c.text)).to.deep.equal(["it's Kurt"]);
      expect(Date.now() - startedAt).to.be.greaterThan(100);
    });

    it('does not wait at all when the turn already has its final', async () => {
      // Four of six turns in the replay were already finalised when the turn ended, because the
      // VAD spends 800ms of silence getting there. Those must not pay a millisecond.
      const provider = makeProvider(true);
      const asInternals = provider as unknown as { handleRecognized(id: string, t: string): void };

      await provider.start();
      asInternals.handleRecognized('chunk_1', 'my name is Kurt');

      const startedAt = Date.now();
      await provider.stop();

      expect(Date.now() - startedAt).to.be.lessThan(100);
      expect(provider.getAllTextChunks().map((c) => c.text)).to.deep.equal(['my name is Kurt']);
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
