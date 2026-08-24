import { createHash } from 'crypto';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { join } from 'path';
import type { AudioFormat } from '../../types/audio';
import type { ErrorCallback, SimpleCallback } from '../../types/callbacks';
import type { GeneratedAudioChunk, ITtsProvider, SpeechGenerationCallback } from '../providers/tts/ITtsProvider';
import { logger } from '../../utils/logger';

/**
 * Utterances worth remembering are short ones. A cache keyed on arbitrary model output would fill
 * with things said once, so only text under this length is stored - which is exactly the class
 * that repeats: greetings, acknowledgements, the line before a transfer.
 */
const MAX_CACHEABLE_CHARS = 240;

/** Refuse to hold a single absurd entry; 30s of 16kHz PCM is already far past a spoken sentence. */
const MAX_CACHEABLE_BYTES = 30 * 16000 * 2;

/** Names what is cached, because the files are hashes and prefix matching needs the words. */
const MANIFEST = 'manifest.json';

/**
 * Speaks from disk when this voice has said these words before.
 *
 * The greeting is the case that motivates it: identical on every call, synthesised afresh every
 * time, and heard at the one moment a caller is deciding whether they have reached something
 * competent. A vendor round-trip there costs both the money and the pause.
 *
 * WHY THE WHOLE UTTERANCE AND NOT EACH SENTENCE. Text arrives in fragments as the model produces
 * it, and the audio for those fragments comes back asynchronously over a socket - so a sentence's
 * audio can arrive after the next sentence has already been sent. Attributing chunks to sentences
 * by arrival order is therefore guesswork, and guessing wrong writes a cache entry whose audio
 * does not match its text, which then plays to every future caller. Everything between `start()`
 * and `end()` belongs to one utterance and needs no attribution at all.
 *
 * The cost of that choice is that a lookup cannot happen until the text is complete, which would
 * be useless. So the text is matched as it accumulates: while what has been said so far is a
 * prefix of something cached, it is held back; the moment it diverges, everything held is handed
 * to the vendor at once.
 *
 * WHY ONLY THE FIRST UTTERANCE OF A CALL. Holding is free only when it ends in a hit. It ends in
 * a hit reliably for exactly one utterance - the greeting, which is identical on every call and
 * is the reason this class exists. Every later reply is a gamble, and it was lost the first time
 * a person listened: a model reuses its openings, so a reply beginning "Great to meet you..." sat
 * held against a cached line that started the same way, produced silence while it accumulated,
 * then arrived as a rush when it finally diverged. Heard down a phone that is not a slow start,
 * it is a broken line.
 *
 * The original reasoning was that on a cold cache nothing is ever a prefix so nothing is ever
 * held. True, and worthless: the cache does not stay cold, and the entries it fills with are
 * precisely the phrasings the model repeats.
 *
 * WHY THE KEY IS THE VOICE TOO. Two lines can speak the same words differently, and serving one
 * line's audio on the other would be baffling to diagnose - it would look like a configuration
 * error anywhere except here. Provider, voice, model and format are all in the hash.
 *
 * Failure is never fatal: a bad read or a failed write is logged and the vendor is used, because
 * a broken cache must degrade to the behaviour that existed before there was one.
 */
export class CachedTtsProvider implements ITtsProvider {
  private onChunk: SpeechGenerationCallback<GeneratedAudioChunk> | null = null;

  /** Everything said this utterance, and the audio that came back for it. */
  private text = '';
  private audio: Buffer[] = [];
  private bytes = 0;

  /** Text accumulated but not yet given to the vendor, while a cache hit is still possible. */
  private held = '';
  /** True once this utterance has been served from cache; nothing more goes to the vendor. */
  private served = false;
  /** True once we have given up on a hit and are streaming to the vendor as usual. */
  private diverged = false;
  private ordinal = 0;

  /** text -> key, loaded once. Small by construction: only short utterances are ever added. */
  private index: Map<string, string> | null = null;

  /**
   * Which utterance of this call is being spoken. Only the first takes part in the cache: see the
   * class comment for what happened when every utterance did.
   */
  private utterance = -1;

  constructor(
    private readonly inner: ITtsProvider,
    private readonly voiceKey: string,
    private readonly cacheDir: string,
  ) {}

  private keyFor(text: string): string {
    return createHash('sha256').update(this.voiceKey).update(' ').update(text).digest('hex');
  }

  private pathFor(key: string): string {
    // One level of fan-out: a flat directory of tens of thousands of files is slow to list and
    // unpleasant to inspect, and inspecting it is how anyone will debug this.
    return join(this.cacheDir, key.slice(0, 2), `${key}.pcm`);
  }

  private manifestPath(): string {
    return join(this.cacheDir, MANIFEST);
  }

  private async loadIndex(): Promise<Map<string, string>> {
    if (this.index) return this.index;
    try {
      const raw = await readFile(this.manifestPath(), 'utf8');
      const parsed = JSON.parse(raw) as Record<string, Record<string, string>>;
      this.index = new Map(Object.entries(parsed[this.voiceKey] ?? {}));
    } catch {
      this.index = new Map();
    }
    return this.index;
  }

  async sendText(text: string): Promise<void> {
    this.text += text;

    if (this.served) return;

    if (this.diverged) {
      await this.inner.sendText(text);
      return;
    }

    this.held += text;
    const index = await this.loadIndex();

    const matched = this.held;
    const exact = index.get(matched);
    if (exact) {
      try {
        const audio = await readFile(this.pathFor(exact));
        // Delivered through the same callback the vendor would have used, so nothing downstream
        // can tell a cached utterance from a synthesised one. That is the point: the guard, the
        // frame splitting and the transport all stay on exactly one path.
        await this.onChunk?.({
          chunkId: `cache-${exact.slice(0, 12)}`,
          ordinal: this.ordinal++,
          audio,
          audioFormat: this.inner.getOutputFormat(),
          text: this.held,
          isFinal: false,
        });
        this.served = true;
        this.held = '';
        // Logged because a cache is otherwise invisible: a miss and a hit produce the same call,
        // and 'it did not store anything that time' is inference, not evidence. Without this the
        // only way to know the cache works is to reason about what is absent from the log.
        logger.info({ chars: matched.length, bytes: audio.byteLength }, 'TTS cache: hit');
        return;
      } catch (error) {
        logger.warn({ error }, 'TTS cache: entry named in the manifest could not be read');
      }
    }

    for (const cached of index.keys()) {
      if (cached.startsWith(this.held)) return; // still might be a hit; keep holding
    }

    // No cached utterance starts this way, so this one is new. Everything held goes over at once.
    this.diverged = true;
    const pending = this.held;
    this.held = '';
    if (pending) await this.inner.sendText(pending);
  }

  /** Stores this utterance if it is worth keeping and was heard in full. */
  private async persist(): Promise<void> {
    const text = this.text;
    const audio = this.audio;
    const bytes = this.bytes;
    this.text = '';
    this.audio = [];
    this.bytes = 0;

    if (this.diverged && this.utterance > 0) return;   // not the greeting; never cached
    if (this.served || audio.length === 0) return;
    if (!text.trim() || text.length > MAX_CACHEABLE_CHARS) return;
    if (bytes === 0 || bytes > MAX_CACHEABLE_BYTES) return;

    const key = this.keyFor(text);
    try {
      await mkdir(join(this.cacheDir, key.slice(0, 2)), { recursive: true });
      // Written aside and renamed: a reader that opened a half-written file would play truncated
      // audio and keep doing so, and a corrupt entry is permanent in a way a slow one is not.
      const target = this.pathFor(key);
      const tmp = `${target}.${process.pid}.tmp`;
      await writeFile(tmp, Buffer.concat(audio));
      await rename(tmp, target);

      const index = await this.loadIndex();
      index.set(text, key);
      // The manifest is re-read before writing so a concurrent call's entries are not dropped.
      // Calls are frequent and short; losing an entry only costs one re-synthesis, but losing
      // ANOTHER voice's whole section would cost every line on the box.
      let all: Record<string, Record<string, string>> = {};
      try {
        all = JSON.parse(await readFile(this.manifestPath(), 'utf8'));
      } catch {
        all = {};
      }
      all[this.voiceKey] = { ...(all[this.voiceKey] ?? {}), [text]: key };
      const tmpManifest = `${this.manifestPath()}.${process.pid}.tmp`;
      await writeFile(tmpManifest, JSON.stringify(all));
      await rename(tmpManifest, this.manifestPath());

      logger.info({ chars: text.length, bytes }, 'TTS cache: stored an utterance');
    } catch (error) {
      logger.warn({ error }, 'TTS cache: could not store an utterance, continuing uncached');
    }
  }

  setOnSpeechGenerating(cb: SpeechGenerationCallback<GeneratedAudioChunk>): void {
    this.onChunk = cb;
    this.inner.setOnSpeechGenerating(async (chunk) => {
      this.audio.push(chunk.audio);
      this.bytes += chunk.audio.byteLength;
      this.ordinal = chunk.ordinal + 1;
      await cb(chunk);
    });
  }

  async end(): Promise<void> {
    // Anything still held was never a hit; the vendor has to say it before the turn can end.
    if (this.held && !this.served) {
      const pending = this.held;
      this.held = '';
      this.diverged = true;
      await this.inner.sendText(pending);
    }
    await this.inner.end();
    await this.persist();
  }

  async cancel(): Promise<void> {
    // A barge-in means the utterance was never heard in full. Storing it would serve that
    // truncation to everyone afterwards.
    this.text = '';
    this.audio = [];
    this.bytes = 0;
    this.held = '';
    if (this.inner.cancel) await this.inner.cancel();
  }

  async start(): Promise<void> {
    this.text = '';
    this.audio = [];
    this.bytes = 0;
    this.held = '';
    this.served = false;
    this.utterance += 1;
    // Everything after the greeting streams to the vendor exactly as it did before this class
    // existed. `diverged` is the flag for "stop trying to match", so setting it up front is the
    // whole opt-out.
    this.diverged = this.utterance > 0;
    this.ordinal = 0;
    await this.inner.start();
  }

  // Pass-through. The cache has no opinion about formats, errors or lifecycle.
  getSupportedFormats(): AudioFormat[] { return this.inner.getSupportedFormats(); }
  getOutputFormat(): AudioFormat { return this.inner.getOutputFormat(); }
  async init(): Promise<void> { await this.inner.init(); }
  setOnGenerationStarted(cb: SimpleCallback): void { this.inner.setOnGenerationStarted(cb); }
  setOnGenerationEnded(cb: SimpleCallback): void { this.inner.setOnGenerationEnded(cb); }
  setOnError(cb: ErrorCallback): void { this.inner.setOnError(cb); }
  async cleanup(): Promise<void> { await this.inner.cleanup(); }
}
