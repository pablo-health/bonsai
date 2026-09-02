import { expect } from 'chai';
import {
  TranscribeAsrProvider,
  transcribeAsrProviderConfigSchema,
  transcribeAsrSettingsSchema,
} from '../../../src/services/providers/asr/TranscribeAsrProvider';

/**
 * The audio frame path must never block on the control plane.
 *
 * Every phone call from 2026-08-31 to 2026-09-02 lost the caller's first utterance: the runner
 * pre-warms the session as the greeting ends, the next frame's sendAudio awaited the Transcribe
 * stream opening - a network round trip - and the LiveKit pump, which awaits the runner, which
 * awaits sendAudio, stalled behind it for 8.3 seconds. Nothing downstream, VAD included, saw a
 * frame until the next stop(). This pins the property directly: with a client whose open never
 * completes, sendAudio still returns at once, and keeps returning.
 */
function makeProvider(): TranscribeAsrProvider {
  const provider = new TranscribeAsrProvider(
    transcribeAsrProviderConfigSchema.parse({ region: 'us-east-1' }),
    transcribeAsrSettingsSchema.parse({ audioFormat: 'pcm_16000', language: 'en-US', continuousStream: true }),
  );
  // A client whose StartStreamTranscription never resolves: the worst case of a slow open.
  (provider as unknown as { client: unknown }).client = {
    send: () => new Promise(() => { /* never */ }),
    destroy: () => { /* nothing */ },
  };
  return provider;
}

describe('TranscribeAsrProvider.sendAudio never blocks on the stream opening', () => {
  it('returns at once on the first frame even when the open never completes', async () => {
    const provider = makeProvider();
    await provider.start();
    const started = Date.now();
    await provider.sendAudio(Buffer.alloc(640));
    await provider.sendAudio(Buffer.alloc(640));
    await provider.sendAudio(Buffer.alloc(640));
    expect(Date.now() - started).to.be.below(50);
  });

  it('keeps the frames queued for the stream rather than dropping them', async () => {
    const provider = makeProvider();
    await provider.start();
    for (let i = 0; i < 5; i++) await provider.sendAudio(Buffer.alloc(640));
    expect((provider as unknown as { queue: Buffer[] }).queue).to.have.length(5);
  });
});
