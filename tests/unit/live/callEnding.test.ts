import 'reflect-metadata';
import { describe, it } from 'mocha';
import { expect } from 'chai';
import { decideCallEnding, endsWithAQuestion } from '../../../src/services/live/callEnding';

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

/**
 * The case that kept happening. On 2026-08-28, twice in consecutive calls from a Delta Sky Club,
 * the agent asked a question, the caller answered it, and the classifier returned caller_finished
 * mid-intake - once after "how do you spell Mimi?" was answered "N I E M I."
 */
describe('decideCallEnding while the caller is answering a question', () => {
  it('ignores an end request when the agent had just asked something', () => {
    expect(decideCallEnding('N I E M I.', false, true)).to.equal('ignore');
    expect(decideCallEnding('Kurtz.', false, true)).to.equal('ignore');
  });

  it('still lets a plain goodbye end the call, question or not', () => {
    // Somebody who says goodbye while being asked their name is still saying goodbye.
    expect(decideCallEnding('okay, bye now', false, true)).to.equal('end');
    expect(decideCallEnding("no, that's everything", false, true)).to.equal('end');
  });

  it('falls back to confirming when no question was pending', () => {
    expect(decideCallEnding('I got the apartment', false, false)).to.equal('confirm-first');
  });
});

describe('endsWithAQuestion', () => {
  it('sees the questions this line actually asks', () => {
    for (const q of [
      'Can I get your first and last name?',
      'Okay, Ming - how do you spell that?',
      'Can I use the number you are calling from, ending in 4201?',
    ]) {
      expect(endsWithAQuestion(q), q).to.equal(true);
    }
  });

  it('allows a short aside after the question', () => {
    expect(endsWithAQuestion('How do you spell that? Take your time.')).to.equal(true);
  });

  it('is not fooled by a question the turn has moved on from', () => {
    expect(endsWithAQuestion(
      'Is that right? Great, I have you down for Tuesday the first at ten in the morning, and we will see you then.',
    )).to.equal(false);
  });

  it('is false for a statement, and for nothing at all', () => {
    expect(endsWithAQuestion('Okay, I have got that down.')).to.equal(false);
    expect(endsWithAQuestion('')).to.equal(false);
    expect(endsWithAQuestion(null)).to.equal(false);
  });
});

describe('decideCallEnding cannot become a call that never ends', () => {
  it('ends once the closing question has been answered, even though it was a question', () => {
    // The closing question ends in "?" like any other. If the question rule were checked first,
    // answering it would read as mid-exchange and the call could never be ended at all.
    expect(decideCallEnding('mm, I think so', true, true)).to.equal('end');
    expect(decideCallEnding(null, true, true)).to.equal('end');
  });
});
