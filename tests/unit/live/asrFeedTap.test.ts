import 'reflect-metadata';
import { describe, it } from 'mocha';
import { expect } from 'chai';
import { AsrFeedTap } from '../../../src/services/live/AsrFeedTap';

/**
 * This sits on a real-time audio path, so its contract is as much about what it must NOT do as
 * what it records. A capture that stalled the generator feeding Transcribe would starve the
 * stream - which is one of the faults it exists to investigate.
 */
describe('AsrFeedTap', () => {
  it('keeps exactly what it was fed, in order', () => {
    const tap = new AsrFeedTap();
    tap.fed(Buffer.from([1, 2]));
    tap.fed(Buffer.from([3, 4]));
    expect([...tap.drain().audio]).to.deep.equal([1, 2, 3, 4]);
  });

  it('counts the frames the provider silently refuses', () => {
    const tap = new AsrFeedTap();
    tap.countAccepted();
    tap.countDroppedNotRecognizing();
    tap.countDroppedNotRecognizing();
    tap.countDroppedEnded();
    const r = tap.drain().report;
    expect(r.framesAccepted).to.equal(1);
    expect(r.framesDroppedNotRecognizing).to.equal(2);
    expect(r.framesDroppedAfterEnded).to.equal(1);
  });

  it('places markers against the audio, not the wall clock', () => {
    // Byte offset is the only timeline that survives a diff against the recording.
    const tap = new AsrFeedTap();
    tap.fed(Buffer.alloc(320));
    tap.mark('stream-open');
    tap.fed(Buffer.alloc(320));
    tap.mark('stop');
    const markers = tap.drain().report.markers as Array<{ event: string; atByte: number }>;
    expect(markers.map((m) => [m.event, m.atByte])).to.deep.equal([['stream-open', 320], ['stop', 640]]);
  });

  it('numbers sessions, so two alive at once is visible', () => {
    // A pre-warmed session transcribing alongside the turn's own is exactly the bug that put
    // "K U K U R T" on a live call; without session numbers it is invisible in every artifact.
    const tap = new AsrFeedTap();
    expect(tap.newSession()).to.equal(1);
    tap.fed(Buffer.alloc(160));
    expect(tap.newSession()).to.equal(2);
    const r = tap.drain().report;
    expect(r.sessions).to.equal(2);
    const markers = r.markers as Array<{ event: string; session: number }>;
    expect(markers.filter((m) => m.event === 'session-begin').map((m) => m.session)).to.deep.equal([1, 2]);
  });

  it('stops growing at the cap rather than taking the process with it', () => {
    const tap = new AsrFeedTap(1000);
    for (let i = 0; i < 20; i++) tap.fed(Buffer.alloc(100));
    const { audio, report } = tap.drain();
    expect(audio.length).to.be.at.most(1100);
    expect(report.truncated).to.equal(true);
  });

  it('bounds the marker list too', () => {
    const tap = new AsrFeedTap();
    for (let i = 0; i < 5000; i++) tap.mark('noise');
    expect((tap.drain().report.markers as unknown[]).length).to.equal(4096);
  });
});
