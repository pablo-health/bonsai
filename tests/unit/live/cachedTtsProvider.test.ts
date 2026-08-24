import { expect } from 'chai';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CachedTtsProvider } from '../../../src/services/live/CachedTtsProvider';
import type { AudioFormat } from '../../../src/types/audio';
import type { GeneratedAudioChunk, ITtsProvider, SpeechGenerationCallback } from '../../../src/services/providers/tts/ITtsProvider';
import type { ErrorCallback, SimpleCallback } from '../../../src/types/callbacks';

/** A vendor that counts how often it was actually asked to synthesise. */
class CountingTts implements ITtsProvider {
  calls: string[] = [];
  private cb: SpeechGenerationCallback<GeneratedAudioChunk> | null = null;

  async sendText(text: string): Promise<void> {
    this.calls.push(text);
    await this.cb?.({
      chunkId: 'c1', ordinal: 0, audio: Buffer.from(`audio:${text}`),
      audioFormat: 'pcm_16000', text, isFinal: true,
    });
  }
  async end(): Promise<void> { /* no-op */ }
  async start(): Promise<void> { /* no-op */ }
  async init(): Promise<void> { /* no-op */ }
  async cleanup(): Promise<void> { /* no-op */ }
  async cancel(): Promise<void> { /* no-op */ }
  getSupportedFormats(): AudioFormat[] { return ['pcm_16000']; }
  getOutputFormat(): AudioFormat { return 'pcm_16000'; }
  setOnGenerationStarted(_cb: SimpleCallback): void { /* no-op */ }
  setOnGenerationEnded(_cb: SimpleCallback): void { /* no-op */ }
  setOnError(_cb: ErrorCallback): void { /* no-op */ }
  setOnSpeechGenerating(cb: SpeechGenerationCallback<GeneratedAudioChunk>): void { this.cb = cb; }
}

/** One full utterance through a cache, returning what reached the transport. */
async function speak(inner: CountingTts, dir: string, voice: string, text: string): Promise<Buffer[]> {
  const heard: Buffer[] = [];
  const cache = new CachedTtsProvider(inner, voice, dir);
  cache.setOnSpeechGenerating(async (chunk) => { heard.push(chunk.audio); });
  await cache.start();
  await cache.sendText(text);
  await cache.end();
  return heard;
}

describe('CachedTtsProvider', () => {
  const GREETING = 'Hi, I am Pablo. How can I help you today?';
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tts-cache-')); });

  it('synthesises the first time and replays the second', async () => {
    const inner = new CountingTts();
    const first = await speak(inner, dir, 'voiceA', GREETING);
    const second = await speak(inner, dir, 'voiceA', GREETING);

    expect(inner.calls).to.have.length(1);          // the vendor was asked exactly once
    expect(second[0].toString()).to.equal(first[0].toString());
  });

  it('does not serve one voice.s audio in another voice', async () => {
    // The bug this prevents would put the marketing line's voice on a practice line: audible,
    // baffling, and indistinguishable from a misconfiguration.
    const inner = new CountingTts();
    await speak(inner, dir, 'voiceA', GREETING);
    await speak(inner, dir, 'voiceB', GREETING);
    expect(inner.calls).to.have.length(2);
  });

  it('does not cache a sentence that was interrupted', async () => {
    // A barge-in means the caller never heard the whole thing. Storing it would serve that
    // truncation to everyone afterwards.
    const inner = new CountingTts();
    const cache = new CachedTtsProvider(inner, 'voiceA', dir);
    cache.setOnSpeechGenerating(async () => { /* discard */ });
    await cache.start();
    await cache.sendText(GREETING);
    await cache.cancel();
    await cache.end();

    await speak(inner, dir, 'voiceA', GREETING);
    expect(inner.calls).to.have.length(2);
  });

  it('leaves long one-off utterances alone', async () => {
    const inner = new CountingTts();
    const essay = 'x'.repeat(400);
    await speak(inner, dir, 'voiceA', essay);
    await speak(inner, dir, 'voiceA', essay);
    expect(inner.calls).to.have.length(2);
  });

  it('matches a cached utterance even though the text arrives in fragments', async () => {
    // The real shape: the model produces the greeting a few tokens at a time, so the cache never
    // sees it as one string. A lookup that waited for a complete utterance would never fire.
    const inner = new CountingTts();
    await speak(inner, dir, 'voiceA', GREETING);

    const heard: Buffer[] = [];
    const cache = new CachedTtsProvider(inner, 'voiceA', dir);
    cache.setOnSpeechGenerating(async (chunk) => { heard.push(chunk.audio); });
    await cache.start();
    for (const piece of ['Hi, I am ', 'Pablo. How can ', 'I help you today?']) {
      await cache.sendText(piece);
    }
    await cache.end();

    expect(inner.calls).to.have.length(1);
    expect(heard.map((b) => b.toString()).join('')).to.contain(GREETING);
  });

  it('says everything it held back when the utterance turns out to be new', async () => {
    // The failure this guards against is the worst one available: text held in the hope of a hit,
    // then dropped when the hope dies, so the agent simply never says the first half of a
    // sentence. Silence mid-utterance reads as a broken line, not as a cache miss.
    const inner = new CountingTts();
    await speak(inner, dir, 'voiceA', GREETING);

    const cache = new CachedTtsProvider(inner, 'voiceA', dir);
    cache.setOnSpeechGenerating(async () => { /* discard */ });
    await cache.start();
    await cache.sendText('Hi, I am ');            // still a prefix of the cached greeting
    await cache.sendText('afraid he is busy.');   // diverges here
    await cache.end();

    const spoken = inner.calls.join('');
    expect(spoken).to.contain('Hi, I am ');
    expect(spoken).to.contain('afraid he is busy.');
  });

  it('never holds text back once the caller is already hearing something', async () => {
    // The bug a person heard. A reply began the way a cached line did, was held while it
    // accumulated, and arrived as silence-then-a-rush. Holding before the first sound is only
    // latency; holding after it is a hole in the middle of a sentence.
    const inner = new CountingTts();
    const cache = new CachedTtsProvider(inner, 'voiceA', dir);
    cache.setOnSpeechGenerating(async () => { /* discard */ });

    await cache.start();
    await cache.sendText('Something new.');   // no match: goes out, and audio comes back
    await cache.end();

    await cache.start();
    await cache.sendText('Also new.');        // audio has been emitted before, but this is a new
    await cache.sendText(' And more.');       // utterance - the second fragment must not be held
    await cache.end();

    expect(inner.calls).to.deep.equal(['Something new.', 'Also new.', ' And more.']);
  });

  it('holds only until the first sound, then never again in that utterance', async () => {
    const inner = new CountingTts();
    await speak(inner, dir, 'voiceA', GREETING);   // cache the greeting

    const cache = new CachedTtsProvider(inner, 'voiceA', dir);
    cache.setOnSpeechGenerating(async () => { /* discard */ });
    await cache.start();

    // A prefix of the cached greeting, so this one fragment is legitimately held - no audio has
    // been emitted yet, so the caller is only waiting for the reply to begin.
    await cache.sendText('Hi, I am ');
    expect(inner.calls).to.have.length(1);          // still just the original synthesis

    // Diverges: everything held is spoken, and nothing is held after that.
    await cache.sendText('afraid he is busy. ');
    await cache.sendText('Can I take a message?');
    await cache.end();

    const spoken = inner.calls.slice(1).join('');
    expect(spoken).to.contain('Hi, I am ');
    expect(spoken).to.contain('afraid he is busy.');
    expect(spoken).to.contain('Can I take a message?');
  });

  it('is keyed on the exact words, so a reworded greeting is a miss not a wrong hit', async () => {
    const inner = new CountingTts();
    await speak(inner, dir, 'voiceA', GREETING);
    const other = await speak(inner, dir, 'voiceA', 'Hi, I am Pablo. How can I help?');
    expect(inner.calls).to.have.length(2);
    expect(other[0].toString()).to.contain('How can I help?');
  });
});
