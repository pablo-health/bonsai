import { expect } from 'chai';
import { GuardedTtsProvider, VoiceOutputGuard } from '../../../src/services/live/VoiceOutputGuard';
import { isProtectedProfileField } from '../../../src/services/live/ProtectedProfileFields';
import type { AudioFormat } from '../../../src/types/audio';
import type { GeneratedAudioChunk, ITtsProvider, SpeechGenerationCallback } from '../../../src/services/providers/tts/ITtsProvider';
import type { ErrorCallback, SimpleCallback } from '../../../src/types/callbacks';

/** Records what actually reached synthesis, which is the only thing that matters here. */
class RecordingTts implements ITtsProvider {
  spoken: string[] = [];
  ended = false;

  async sendText(text: string): Promise<void> { this.spoken.push(text); }
  async end(): Promise<void> { this.ended = true; }
  async start(): Promise<void> { /* no-op */ }
  async init(): Promise<void> { /* no-op */ }
  async cleanup(): Promise<void> { /* no-op */ }
  getSupportedFormats(): AudioFormat[] { return ['pcm_16000']; }
  getOutputFormat(): AudioFormat { return 'pcm_16000'; }
  setOnGenerationStarted(_cb: SimpleCallback): void { /* no-op */ }
  setOnGenerationEnded(_cb: SimpleCallback): void { /* no-op */ }
  setOnError(_cb: ErrorCallback): void { /* no-op */ }
  setOnSpeechGenerating(_cb: SpeechGenerationCallback<GeneratedAudioChunk>): void { /* no-op */ }

  all(): string { return this.spoken.join(''); }
}

describe('VoiceOutputGuard', () => {
  describe('digit sequences', () => {
    it('blocks a card-length run of digits', () => {
      const guard = new VoiceOutputGuard();
      const out = guard.screen('The number is 4111 1111 1111 1111.');
      expect(out).to.not.include('4111');
      expect(guard.getViolations()).to.have.lengthOf(1);
    });

    it('blocks a run spelled out as words, which a numeric-only rule would miss', () => {
      const guard = new VoiceOutputGuard();
      const out = guard.screen('It is four one one two.');
      expect(out.toLowerCase()).to.not.include('four one one two');
      expect(guard.getViolations()).to.have.lengthOf(1);
    });

    it('blocks digits even when the agent invented them', () => {
      // A fabricated card number is still a card number to whoever is recording the call.
      const guard = new VoiceOutputGuard();
      const out = guard.screen('For example, 1234 5678 9012 3456.');
      expect(out).to.not.include('1234');
    });

    it('leaves times and short counts alone', () => {
      const guard = new VoiceOutputGuard();
      for (const ok of ['He is free at 3pm.', 'It will take 15 minutes.', 'Call back in 2 hours.']) {
        expect(guard.screen(ok)).to.equal(ok);
      }
      expect(guard.getViolations()).to.be.empty;
    });
  });

  describe('affirmatives', () => {
    it('does NOT block a plain yes', () => {
      // Deliberate: a clipped affirmative is not assent, and gating it mangles legitimate speech
      // on the known-caller path. See the note in VoiceOutputGuard.
      const guard = new VoiceOutputGuard();
      expect(guard.screen('Yes, he is free Thursday.')).to.equal('Yes, he is free Thursday.');
      expect(guard.getViolations()).to.be.empty;
    });
  });

  describe('GuardedTtsProvider', () => {
    it('screens text that arrives split across streaming chunks', async () => {
      // The whole point of buffering: a model streams "4111 " and "1111 1111 1111." separately,
      // and neither fragment alone trips a rule that the sentence does.
      const inner = new RecordingTts();
      const wrapped = new GuardedTtsProvider(inner, new VoiceOutputGuard());
      await wrapped.start();
      await wrapped.sendText('The card is 4111 ');
      await wrapped.sendText('1111 1111 1111.');
      await wrapped.end();
      expect(inner.all()).to.not.include('4111');
      expect(inner.ended).to.equal(true);
    });

    it('flushes a trailing fragment with no terminator on end()', async () => {
      const inner = new RecordingTts();
      const wrapped = new GuardedTtsProvider(inner, new VoiceOutputGuard());
      await wrapped.start();
      await wrapped.sendText('no full stop here');
      await wrapped.end();
      expect(inner.all()).to.include('no full stop here');
    });

    it('passes ordinary speech through unchanged', async () => {
      const inner = new RecordingTts();
      const wrapped = new GuardedTtsProvider(inner, new VoiceOutputGuard());
      await wrapped.start();
      await wrapped.sendText('Hi, this is the assistant. Can I take a message?');
      await wrapped.end();
      expect(inner.all()).to.include('Can I take a message?');
    });

    it('drops the buffer on cancel so a barge-in cannot leak into the next turn', async () => {
      const inner = new RecordingTts();
      const wrapped = new GuardedTtsProvider(inner, new VoiceOutputGuard());
      await wrapped.start();
      await wrapped.sendText('half a sentence');
      await wrapped.cancel();
      await wrapped.end();
      expect(inner.all()).to.not.include('half a sentence');
    });
  });
});

describe('VoiceOutputGuard caller echo', () => {
  it('reads back a number the caller just gave', () => {
    const guard = new VoiceOutputGuard();
    guard.noteCallerSpeech('You can reach me at 404-555-0182.');
    const spoken = guard.screen('Let me read that back: 404-555-0182?');
    expect(spoken).to.contain('404-555-0182');
  });

  it('still refuses a number the caller never said', () => {
    const guard = new VoiceOutputGuard();
    guard.noteCallerSpeech('You can reach me at 404-555-0182.');
    // The number the agent would be disclosing is not the caller's, so the exemption must not
    // apply just because SOME number was heard earlier in the call.
    expect(guard.screen('You can call the office on 404-555-0199.')).to.not.contain('0199');
  });

  it('refuses when the caller has said nothing at all', () => {
    const guard = new VoiceOutputGuard();
    expect(guard.screen('The reference is 8891 2247.')).to.not.contain('8891');
  });

  it('matches across grouping and spelling', () => {
    const guard = new VoiceOutputGuard();
    guard.noteCallerSpeech('my number is five five five, oh one eight two');
    expect(guard.screen('So that is 555-0182?')).to.contain('555-0182');
  });

  it('blocks a sentence that pairs the caller.s number with an unknown one', () => {
    const guard = new VoiceOutputGuard();
    guard.noteCallerSpeech('reach me at 404-555-0182');
    const spoken = guard.screen('I have 404-555-0182, and the direct line is 404-555-0143.');
    expect(spoken).to.not.contain('0143');
  });
});

describe('ProtectedProfileFields', () => {
  it('protects the field that decides whether a caller is bridged', () => {
    expect(isProtectedProfileField('transferTo')).to.equal(true);
    expect(isProtectedProfileField('known')).to.equal(true);
  });

  it('is not defeated by casing or separators', () => {
    // The field name comes from authored action config, so transfer_to must not be a way around
    // transferTo.
    for (const alias of ['transfer_to', 'TRANSFER-TO', 'Transfer To', 'transferto']) {
      expect(isProtectedProfileField(alias), alias).to.equal(true);
    }
  });

  it('leaves ordinary profile fields writable', () => {
    for (const ok of ['name', 'company', 'greetings', 'relationship', 'callbackNumber']) {
      expect(isProtectedProfileField(ok), ok).to.equal(false);
    }
  });
});

/**
 * A number with digits missing is not a disclosure problem, so the echo exemption above waves it
 * through: the caller DID say it. On 2026-08-27 this line read back "4-7-5-4-4-2-0-1", the caller
 * said yes, and an appointment was booked with no way to reach them. A readback only invites
 * agreement, and "yes" is the cheapest thing a caller in a noisy place can say - so the count has
 * to be the check.
 */
describe('VoiceOutputGuard phone number length', () => {
  /** The agent's own question is what arms the check, so tests have to ask it first. */
  function askedForNumber(): VoiceOutputGuard {
    const guard = new VoiceOutputGuard();
    guard.screen('And what is a good number to reach you on?');
    return guard;
  }

  it('will not read back a number that is too short to be one', () => {
    const guard = askedForNumber();
    guard.noteCallerSpeech('47544201');
    const spoken = guard.screen('Got it - let me read that back to you: 4-7-5-4-4-2-0-1. Is that right?');
    expect(spoken).to.not.contain('4-7-5-4-4-2-0-1');
    expect(spoken).to.contain('area code');
  });

  it('reads back a full ten-digit number unchanged', () => {
    const guard = askedForNumber();
    guard.noteCallerSpeech('it is 404-754-4201');
    expect(guard.screen('Let me read that back: 404-754-4201?')).to.contain('404-754-4201');
  });

  it('accepts eleven digits with a leading one', () => {
    const guard = askedForNumber();
    guard.noteCallerSpeech('one, four zero four, seven five four, four two zero one');
    expect(guard.screen('That is 1-404-754-4201?')).to.contain('404-754-4201');
  });

  it('holds nothing to a phone number.s shape until a phone number has been asked for', () => {
    // A date of birth or a member ID read back earlier in the call is not a phone number and
    // must not be judged as one.
    const guard = new VoiceOutputGuard();
    guard.noteCallerSpeech('03151985');
    expect(guard.screen('So that is 0-3-1-5-1-9-8-5?')).to.contain('0-3-1-5-1-9-8-5');
  });

  it('stops checking once a usable number has been read back', () => {
    const guard = askedForNumber();
    guard.noteCallerSpeech('404-754-4201');
    guard.screen('Let me read that back: 404-754-4201?');
    guard.noteCallerSpeech('my member id is 8891 2247');
    expect(guard.screen('And the member ID is 8891 2247?')).to.contain('8891 2247');
  });

  it('rejects an area code that cannot exist', () => {
    const guard = askedForNumber();
    guard.noteCallerSpeech('0447544201');
    expect(guard.screen('Reading that back: 044-754-4201?')).to.contain('area code');
  });

  it('records what it replaced, so the call record shows it', () => {
    const guard = askedForNumber();
    guard.noteCallerSpeech('47544201');
    guard.screen('Let me read that back: 4-7-5-4-4-2-0-1?');
    const violations = guard.getViolations();
    expect(violations.map((v) => v.rule)).to.contain('phone-length');
  });
});
