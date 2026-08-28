import { expect } from 'chai';
import { phoneticKey, soundAlikeDistance, matchName, resolveName } from '../../../src/services/live/nameMatching';

/** A small roster standing in for a practice's patient list plus a common-surname list. */
const ROSTER = ['Niemi', 'Mimi', 'Nunez', 'Smith', 'Jones', 'Patel', 'Nguyen', 'Kurt', 'Curt', 'Hertz', 'Garcia'];

describe('nameMatching', () => {
  describe('phoneticKey', () => {
    it('drops vowel quality after the first sound, which is what noise takes first', () => {
      expect(phoneticKey('Niemi')).to.equal(phoneticKey('Niemy'));
    });

    it('collapses a doubled sound, since it is one sound', () => {
      expect(phoneticKey('Niemmi')).to.equal(phoneticKey('Niemi'));
    });

    it('is not confused by capitalisation or punctuation', () => {
      expect(phoneticKey("o'BRIEN")).to.equal(phoneticKey('OBrien'));
    });
  });

  describe('soundAlikeDistance', () => {
    it('charges almost nothing for M and N, which a phone line cannot separate', () => {
      // The observed error: the recogniser heard NIEMI's first letter as M, and the agent read
      // the mistake back phonetically and confidently.
      const cheap = soundAlikeDistance(phoneticKey('Niemi'), phoneticKey('Miemi'));
      const fullPrice = soundAlikeDistance(phoneticKey('Niemi'), phoneticKey('Riemi'));
      expect(cheap).to.be.lessThan(fullPrice);
      expect(cheap).to.be.lessThan(0.5);
    });

    it('charges full price for sounds the line carries perfectly well', () => {
      // Patel and Garcia share no confusable sound, so every substitution is full price.
      expect(soundAlikeDistance(phoneticKey('Patel'), phoneticKey('Garcia'))).to.be.greaterThan(2.5);
    });

    it('is lenient about TH heard as S, which is why Smith is not far from Jones', () => {
      // Worth pinning rather than leaving implicit: TH sits in the fricative class with F and S,
      // so "Smith"/"Smiss" is cheap - and a side effect is that two unrelated common surnames end
      // up closer than intuition suggests. maxDistance in matchName is what keeps that from
      // producing matches; the distance itself is not meant to be a similarity judgement.
      expect(soundAlikeDistance(phoneticKey('Smith'), phoneticKey('Jones'))).to.be.greaterThan(1.5);
    });
  });

  describe('matchName', () => {
    it('resolves the mishearing that a real call booked on', () => {
      // conv_01a044f3: the agent settled on M-I-E-M-I and read it back as "M as in Mary, I, E,
      // M as in Mary, I". The name is NIEMI. Against a roster holding the real patient, the
      // mishearing reaches them.
      const matches = matchName(['Miemi'], ['Niemi', 'Smith', 'Jones', 'Garcia']);
      expect(matches[0].name).to.equal('Niemi');
    });

    it('does NOT quietly pick between two roster names that sound the same', () => {
      // Mimi and Niemi are one telephone-confusable sound apart, so a roster holding both cannot
      // be resolved by sound alone - and picking the nearer one is exactly how a wrong name gets
      // written into a record. resolveName turns this into a question; matchName must not hide it.
      const matches = matchName(['Miemi'], ROSTER);
      expect(matches.slice(0, 2).map(m => m.name)).to.have.members(['Mimi', 'Niemi']);
    });

    it('reaches the right name from a hypothesis several sounds adrift', () => {
      const matches = matchName(['Mimi'], ROSTER);
      expect(matches.map(m => m.name)).to.include('Niemi');
    });

    it('cannot reach "Kurt" from "Hertz", and that is the honest limit', () => {
      // Measured on 2026-08-28: the caller said "Kurt" and the line heard "Hertz", at higher
      // confidence with the name in the custom vocabulary than without it. The /k/ burst lives
      // above 3400 Hz and the codec discards it, so the hypothesis was never generated. Sound
      // matching cannot recover information the channel destroyed - this is the slice where a
      // provisional booking plus a text confirmation belongs, and pretending otherwise by widening
      // the distance until it passes would make every noisy turn match something.
      expect(matchName(['Hertz'], ['Kurt', 'Curt'])).to.have.length(0);
    });

    it('uses the whole n-best list, not just the top hypothesis', () => {
      // The top hypothesis is unrelated; the right name is second. Reading Alternatives[0] only -
      // which is what the provider does today - throws this away.
      const matches = matchName(['Garcia', 'Miemi'], ['Niemi', 'Smith', 'Jones']);
      expect(matches[0].name).to.equal('Niemi');
      expect(matches[0].heard).to.equal('Miemi');
    });

    it('offers nothing for a name that is genuinely not on the list', () => {
      expect(matchName(['Zbigniew'], ROSTER)).to.have.length(0);
    });
  });

  describe('resolveName', () => {
    it('takes a clear match without asking the caller anything', () => {
      const resolved = resolveName(matchName(['Niemi'], ['Niemi', 'Smith', 'Jones']));
      expect(resolved).to.deep.equal({ outcome: 'accept', name: 'Niemi' });
    });

    it('OFFERS A CHOICE rather than picking between two names that sound alike', () => {
      // Confidently picking one here is how a wrong name gets written into a record and then read
      // back convincingly. A two-way choice survives a noisy line; asking for a re-spell does not,
      // because it re-samples exactly the information the channel already destroyed.
      const resolved = resolveName(matchName(['Mimi'], ['Niemi', 'Mimi'])) as { outcome: string; names: string[] };
      expect(resolved.outcome).to.equal('offer');
      expect(resolved.names).to.have.members(['Niemi', 'Mimi']);
    });

    it('never reads out more than two, because a menu on a phone line is worse than a question', () => {
      const resolved = resolveName(matchName(['Miemi'], ['Niemi', 'Mimi', 'Niemy', 'Nemi'])) as { names: string[] };
      expect(resolved.names).to.have.length(2);
    });

    it('says so plainly when nothing matches, which is where text confirmation belongs', () => {
      expect(resolveName([])).to.deep.equal({ outcome: 'unresolved' });
    });
  });
});
