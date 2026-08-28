import { expect } from 'chai';
import {
  parseIntakeDefinition, parseSpelling, parsePhone, validateSlotValue, spokenDigitsToDigits,
  intakeState, turnLooksComplete, DEFERRED_SUFFIX,
  type IntakeDefinition,
} from '../../../src/services/live/intakeSequence';

/** The demo practice's intake, in the order a receptionist would take it. */
const DEF: IntakeDefinition = {
  slots: [
    { name: 'first_name', kind: 'name', required: true, asks: 'their first name', maxAttempts: 3 },
    { name: 'last_name_spelling', kind: 'spelling', required: true, asks: 'how the surname is spelled', maxAttempts: 3 },
    { name: 'callback_number', kind: 'phone', required: true, asks: 'a number to reach them on', maxAttempts: 3 },
    { name: 'appointment_time', kind: 'datetime', required: true, asks: 'when they would like to come in', maxAttempts: 3 },
    { name: 'insurance', kind: 'text', required: false, asks: 'whether they are using insurance', maxAttempts: 2 },
  ],
};

describe('intakeSequence', () => {
  describe('parseSpelling', () => {
    it('reads "N as in Nancy" as the letter, not as Nancy', () => {
      // The exact transcript shape the agent is told to speak, arriving back from a caller.
      const result = parseSpelling('N as in Nancy, I, E, M as in Mary, I');
      expect(result.ok).to.equal(true);
      expect((result as { value: string }).value).to.equal('NIEMI');
    });

    it('accepts the NATO alphabet spoken bare', () => {
      const result = parseSpelling('November India Echo Mike India');
      expect((result as { value: string }).value).to.equal('NIEMI');
    });

    it('accepts bare letters with the filler people actually say', () => {
      const result = parseSpelling("it's K U R T");
      expect((result as { value: string }).value).to.equal('KURT');
    });

    it('refuses a sentence that is not a spelling', () => {
      expect(parseSpelling('I would like an appointment please').ok).to.equal(false);
    });

    it('refuses a single letter, which cannot be a surname', () => {
      expect(parseSpelling('K').ok).to.equal(false);
    });
  });

  describe('parsePhone', () => {
    it('accepts ten digits however they are spaced', () => {
      expect((parsePhone('404 754 4201') as { value: string }).value).to.equal('4047544201');
    });

    it('drops a leading country code', () => {
      expect((parsePhone('1 404 754 4201') as { value: string }).value).to.equal('4047544201');
    });

    it('REFUSES the eight-digit number a real call booked on', () => {
      // Read back as "4-7-5-4-4-2-0-1", agreed to by the caller, and the practice was left with
      // no way to reach them. The count is the check; the readback is not.
      const result = parsePhone('4 7 5 4 4 2 0 1');
      expect(result.ok).to.equal(false);
      expect((result as { reason: string }).reason).to.contain('8 digits');
    });

    it('refuses an area code that cannot exist', () => {
      expect(parsePhone('104 754 4201').ok).to.equal(false);
    });
  });

  describe('spokenDigitsToDigits', () => {
    it('reads a number said aloud as words', () => {
      // Transcribe returns number words as words far more often than as digits, and a digits-only
      // strip would turn this correct ten-digit number into a seven-digit one.
      expect(spokenDigitsToDigits('four oh four seven five four forty two oh one')).to.equal('4047544201');
    });

    it('does not turn "forty two" into three digits', () => {
      expect(spokenDigitsToDigits('forty two')).to.equal('42');
    });

    it('reads a bare tens word as the round number it is', () => {
      expect(spokenDigitsToDigits('forty')).to.equal('40');
    });

    it('expands the way people compress repeats', () => {
      expect(spokenDigitsToDigits('double four seven triple two')).to.equal('447222');
    });

    it('skips the words in front of a number rather than choking on them', () => {
      expect(spokenDigitsToDigits("it's area code 404 then 7544201")).to.equal('4047544201');
    });
  });

  describe('validateSlotValue', () => {
    it('refuses the ASR placeholders that reached a name slot on a real call', () => {
      for (const placeholder of ['[silence]', '[unclear]', '[unintelligible]']) {
        expect(validateSlotValue('name', placeholder).ok, placeholder).to.equal(false);
      }
    });

    it('accepts an ordinary first name', () => {
      expect(validateSlotValue('name', 'Kurt').ok).to.equal(true);
    });

    it('reads yes and no through the words people use', () => {
      expect((validateSlotValue('yes_no', 'yeah, that works') as { value: string }).value).to.equal('yes');
      expect((validateSlotValue('yes_no', "no, I'd rather not") as { value: string }).value).to.equal('no');
    });
  });

  describe('intakeState', () => {
    it('names the first unfilled required slot as the one being collected', () => {
      const state = intakeState(DEF, { first_name: 'Kurt' });
      expect(state.current?.name).to.equal('last_name_spelling');
      expect(state.complete).to.equal(false);
    });

    it('is NOT complete while a required slot is empty, whatever else is filled', () => {
      // This is the 2026-08-28 04:59 call: name and spelling taken, then the classifier decided
      // the caller was finished. With a sequence, ending is simply not available here.
      const state = intakeState(DEF, { first_name: 'Kurt', last_name_spelling: 'NIEMI' });
      expect(state.complete).to.equal(false);
      expect(state.remaining.map(s => s.name)).to.deep.equal(['callback_number', 'appointment_time']);
    });

    it('is complete once every required slot is filled, ignoring optional ones', () => {
      const state = intakeState(DEF, {
        first_name: 'Kurt', last_name_spelling: 'NIEMI',
        callback_number: '4047544201', appointment_time: 'Tuesday 10am',
      });
      expect(state.complete).to.equal(true);
      expect(state.current).to.equal(null);
    });

    it('treats a parked slot as settled rather than outstanding', () => {
      // Parking is how a field moves to a text confirmation instead of being asked a fourth time,
      // and it is what lets the rest of the flow be tested without writing a wrong name.
      const state = intakeState(DEF, {
        first_name: 'Kurt', [`last_name_spelling${DEFERRED_SUFFIX}`]: true,
        callback_number: '4047544201', appointment_time: 'Tuesday 10am',
      });
      expect(state.complete).to.equal(true);
      expect(state.deferred).to.deep.equal(['last_name_spelling']);
    });
  });

  describe('turnLooksComplete', () => {
    it('ends a digits turn the moment ten digits are in hand', () => {
      expect(turnLooksComplete('phone', 'four oh four 754 4201')).to.equal(true);
    });

    it('has NO OPINION on a half-given number, rather than declaring it incomplete', () => {
      // The distinction matters: an opinion of "false" would be a gate that could hold a turn
      // open, and a suppression path with no exit is the bug class this system keeps producing.
      expect(turnLooksComplete('phone', '404 754')).to.equal(null);
    });

    it('has no opinion on an open question, leaving the acoustic signal in charge', () => {
      expect(turnLooksComplete(null, 'I was hoping to book an appointment')).to.equal(null);
    });

    it('has no opinion on a yes it does not recognise, which costs nothing', () => {
      expect(turnLooksComplete('yes_no', 'I suppose that would be alright')).to.equal(null);
    });
  });

  describe('parseIntakeDefinition', () => {
    it('reads a definition off stage metadata', () => {
      expect(parseIntakeDefinition({ intake: DEF })?.slots).to.have.length(5);
    });

    it('returns null for a stage that declares no sequence', () => {
      expect(parseIntakeDefinition({})).to.equal(null);
      expect(parseIntakeDefinition(null)).to.equal(null);
    });

    it('returns null rather than throwing on a malformed definition', () => {
      expect(parseIntakeDefinition({ intake: { slots: 'everything' } })).to.equal(null);
    });
  });
});
