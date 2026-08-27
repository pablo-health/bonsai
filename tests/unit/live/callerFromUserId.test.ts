import 'reflect-metadata';
import { describe, it } from 'mocha';
import { expect } from 'chai';
import { callerFromUserId } from "../../../src/services/live/callerNumber";

/**
 * On a phone call the network hands us the caller's number before anyone speaks, and the SIP
 * channel makes it the conversation's user id. A line that then asks the caller to read it out is
 * asking for something it already has - which on 2026-08-27, in a concert queue, took four failed
 * attempts and ended the call.
 */
describe('callerFromUserId', () => {
  it('reads an E.164 number off a SIP user id', () => {
    expect(callerFromUserId('+14047544201')).to.deep.equal({ number: '+14047544201', lastFour: '4201' });
  });

  it('gives nulls for an id that is not a phone number', () => {
    // Every non-SIP channel sets a user id of some other shape, and nulls are the honest answer.
    for (const id of ['user_01a03036', 'kurt@example.com', '@someone', '']) {
      expect(callerFromUserId(id), id).to.deep.equal({ number: null, lastFour: null });
    }
  });

  it('gives nulls when the caller withholds their number', () => {
    expect(callerFromUserId(null)).to.deep.equal({ number: null, lastFour: null });
    expect(callerFromUserId(undefined)).to.deep.equal({ number: null, lastFour: null });
  });

  it('rejects things that are numeric but not dialable', () => {
    expect(callerFromUserId('+0447544201').number, 'country code cannot start with 0').to.equal(null);
    expect(callerFromUserId('4047544201').number, 'no leading plus is not E.164').to.equal(null);
    expect(callerFromUserId('+1404').number, 'too short to be a number').to.equal(null);
    expect(callerFromUserId('+1404754420188888').number, 'longer than E.164 allows').to.equal(null);
  });

  it('tolerates surrounding whitespace', () => {
    expect(callerFromUserId('  +14047544201 ').lastFour).to.equal('4201');
  });
});
