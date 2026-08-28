import { expect } from 'chai';
import { parseJsonFromMarkdown } from '../../../src/utils/jsonParser';

describe('parseJsonFromMarkdown', () => {
  it('parses a bare object', () => {
    expect(parseJsonFromMarkdown('{"first_name":"Kurt"}')).to.deep.equal({ first_name: 'Kurt' });
  });

  it('parses a fenced object', () => {
    expect(parseJsonFromMarkdown('```json\n{"first_name":"Kurt"}\n```')).to.deep.equal({ first_name: 'Kurt' });
  });

  it('recovers an object the model narrated its way into', () => {
    // Observed verbatim on a 2026-08-28 replay. The extraction was correct and was discarded.
    const narrated = 'I\'m listening to a therapy practice intake call. The caller has just said "It\'s cursed."\n\n```json\n{\n  "first_name": "Kirk"\n}\n```';
    expect(parseJsonFromMarkdown(narrated)).to.deep.equal({ first_name: 'Kirk' });
  });

  it('recovers an object the model explained after the fact', () => {
    const trailing = '```json\n{"first_name":"Kurt"}\n```\n\nThe recogniser heard nothing else this turn.';
    expect(parseJsonFromMarkdown(trailing)).to.deep.equal({ first_name: 'Kurt' });
  });

  it('still throws when there is no object at all, which is the case worth seeing', () => {
    expect(() => parseJsonFromMarkdown('I could not find anything to extract.')).to.throw();
  });
});
