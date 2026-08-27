import 'reflect-metadata';
import { describe, it } from 'mocha';
import { expect } from 'chai';
import { joinFillerToReply } from '../../../src/utils/llm';

/**
 * The filler model and the reply model produce two strings that are spoken as one utterance, so
 * how they are joined is what the caller actually hears. Observed on a live call on 2026-08-27:
 * "Sure" + "Of course. What's your first and last name?" went out as "Sure Of course", with no
 * pause where a sentence had ended.
 */
describe('joinFillerToReply', () => {
  it('breaks the sentence when the filler ends mid-thought and the reply starts a new one', () => {
    expect(joinFillerToReply('Sure', "Of course. What's your first and last name?"))
      .to.equal("Sure. Of course. What's your first and last name?");
  });

  it('leaves a filler that already ends a sentence alone', () => {
    expect(joinFillerToReply('Understood.', "I'd be happy to help you set that up."))
      .to.equal("Understood. I'd be happy to help you set that up.");
  });

  it('does not break a reply that continues the filler', () => {
    expect(joinFillerToReply('Let me check that', 'for you right now.'))
      .to.equal('Let me check that for you right now.');
  });

  it('keeps a trailing dash open, because it opens a clause rather than closing one', () => {
    expect(joinFillerToReply('Got it -', "you're looking for a different Pablo."))
      .to.equal("Got it - you're looking for a different Pablo.");
  });

  it('still attaches closing punctuation tight', () => {
    expect(joinFillerToReply('Sure', ', let me look.')).to.equal('Sure, let me look.');
  });

  it('passes the reply through when there is no filler', () => {
    expect(joinFillerToReply(null, '  What can I do for you? ')).to.equal('What can I do for you?');
  });
});
