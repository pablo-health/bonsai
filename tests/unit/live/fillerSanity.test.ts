import 'reflect-metadata';
import { describe, it } from 'mocha';
import { expect } from 'chai';
import { sanitiseFiller } from '../../../src/services/live/fillerSanity';

describe('sanitiseFiller', () => {
  it('keeps the acknowledgements the prompt actually asks for', () => {
    for (const ok of ['Got it', 'Okay', 'Mm-hm', 'Right', 'Sure', 'Of course', 'That makes sense']) {
      expect(sanitiseFiller(ok), ok).to.equal(ok);
    }
  });

  it('drops the leaked instruction a caller actually heard', () => {
    // Delta Sky Club, 2026-08-28: "Acknowledge only: OkayRight, I didn't catch that..."
    expect(sanitiseFiller('Acknowledge only:')).to.equal(null);
    expect(sanitiseFiller('Output one short acknowledgement')).to.equal(null);
  });

  it('drops anything shaped like a label and a value', () => {
    expect(sanitiseFiller('Filler: Got it')).to.equal(null);
  });

  it('drops a list, which the synthesiser would read as one run-on line', () => {
    expect(sanitiseFiller('Got it\nOkay\nRight')).to.equal(null);
  });

  it('drops anything longer than an acknowledgement', () => {
    expect(sanitiseFiller('Okay well that is certainly something I can help with')).to.equal(null);
  });

  it('trims, and treats empty as nothing to say', () => {
    expect(sanitiseFiller('  Got it  ')).to.equal('Got it');
    expect(sanitiseFiller('   ')).to.equal(null);
  });
});
