import 'reflect-metadata';
import { describe, it } from 'mocha';
import { expect } from 'chai';
import { decideCallEnding } from '../../../src/services/live/callEnding';

/**
 * On 2026-08-27 a call ended because one utterance was classified as the caller being finished.
 * The utterance was "I got the fucking apartment." - itself a mishearing on a noisy line - and the
 * caller had asked for nothing and been given nothing. Hanging up is irreversible: they have to
 * dial again and start over.
 */
describe('decideCallEnding', () => {
  it('confirms first when the caller only sounded content', () => {
    expect(decideCallEnding('I got the fucking apartment.', false)).to.equal('confirm-first');
    expect(decideCallEnding("that's great", false)).to.equal('confirm-first');
    expect(decideCallEnding('yeah', false)).to.equal('confirm-first');
    expect(decideCallEnding('okay', false)).to.equal('confirm-first');
  });

  it('confirms first when nothing was heard at all', () => {
    expect(decideCallEnding(null, false)).to.equal('confirm-first');
    expect(decideCallEnding('', false)).to.equal('confirm-first');
    expect(decideCallEnding('[unintelligible]', false)).to.equal('confirm-first');
  });

  it('ends straight away on a plain goodbye', () => {
    for (const farewell of [
      'bye', 'goodbye', 'okay, bye now', 'thanks, take care',
      "no, that's everything", 'no thank you', "I'm all set",
      "that's all I needed", 'nope, all set', 'nothing else, thanks',
    ]) {
      expect(decideCallEnding(farewell, false), farewell).to.equal('end');
    }
  });

  it('ends once the closing question has been answered', () => {
    // The second request is the one that counts, because by then the agent has actually asked.
    expect(decideCallEnding('I got the apartment', true)).to.equal('end');
    expect(decideCallEnding(null, true)).to.equal('end');
  });
});
