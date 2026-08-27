import 'reflect-metadata';
import { describe, it } from 'mocha';
import { expect } from 'chai';
import { assessTranscriptConfidence } from '../../../src/services/live/asrNoiseGate';
import type { TextChunk } from '../../../src/services/providers/asr/IAsrProvider';

const chunk = (text: string, confidence?: number): TextChunk =>
  ({ chunkId: 'chunk_test', text, timestamp: new Date(0), confidence });

/**
 * Observed on the demo line on 2026-08-27: the caller said nothing at all for a whole call, and
 * four turns were opened anyway - "Yeah", "That", and two unintelligible placeholders - all of it
 * other people in the room. The recogniser's own confidence is what separates them from a caller.
 */
describe('assessTranscriptConfidence', () => {
  it('drops background chatter that came back weakly scored', () => {
    const result = assessTranscriptConfidence([chunk('Yeah', 0.31), chunk('That', 0.24)], 0.6);
    expect(result.passes).to.equal(false);
    expect(result.meanConfidence).to.be.closeTo(0.275, 0.0001);
  });

  it('keeps a short answer the caller actually said into the microphone', () => {
    // A bare "yes" is load-bearing - it is how a handoff is accepted - so the gate has to be
    // about confidence, never about how many words were spoken.
    expect(assessTranscriptConfidence([chunk('Yes', 0.97)], 0.6).passes).to.equal(true);
  });

  it('accepts everything when no threshold is configured', () => {
    expect(assessTranscriptConfidence([chunk('Yeah', 0.05)], undefined).passes).to.equal(true);
  });

  it('treats a provider that reports no confidence as unknown, not as low', () => {
    expect(assessTranscriptConfidence([chunk('hello there')], 0.9).passes).to.equal(true);
    expect(assessTranscriptConfidence([chunk('hello there')], 0.9).meanConfidence).to.equal(undefined);
  });

  it('ignores empty chunks when averaging', () => {
    const result = assessTranscriptConfidence([chunk('   ', 0.01), chunk('appointment', 0.9)], 0.6);
    expect(result.passes).to.equal(true);
    expect(result.meanConfidence).to.be.closeTo(0.9, 0.0001);
  });

  it('passes a transcript exactly on the threshold', () => {
    expect(assessTranscriptConfidence([chunk('maybe', 0.6)], 0.6).passes).to.equal(true);
  });
});
