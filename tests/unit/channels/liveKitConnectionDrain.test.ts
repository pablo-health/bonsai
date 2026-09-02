import 'reflect-metadata';
import { describe, it } from 'mocha';
import { expect } from 'chai';
import { LiveKitConnection, PSTN_TAIL_MS, DRAIN_BOUND_MS } from '../../../src/channels/livekit/LiveKitConnection';
import type { DrainClock } from '../../../src/channels/livekit/LiveKitConnection';

/**
 * On 2026-08-31 the caller was removed from the room 300ms after the last byte of "Take care."
 * was synthesised, and heard the goodbye cut off. `waitForPlayout` had resolved: the source's
 * queue was empty at that instant, while a chunk loop still held the rest of the sentence and the
 * carrier still held what had already left the source. The drain has to wait for both.
 */

/** A source that captures instantly and can be told to block, so a loop can be caught mid-chunk. */
class FakeSource {
  queuedDuration = 0;
  captured: number[] = [];
  playoutWaits = 0;
  gate: Promise<void> | null = null;
  async captureFrame(frame: { samplesPerChannel: number; sampleRate: number }): Promise<void> {
    if (this.gate) await this.gate;
    this.captured.push(frame.samplesPerChannel);
  }
  async waitForPlayout(): Promise<void> { this.playoutWaits += 1; }
  clearQueue(): void { /* nothing queued */ }
  closed = false;
  async close(): Promise<void> { this.closed = true; }
}

/** A room that can be left and nothing more. */
const fakeRoom = { name: 'test-room', disconnect: async () => {} };

/**
 * A clock that moves only when the test says so, and records every sleep it is asked for.
 *
 * Sleeps do not advance it: the drain polls its waits in short sleeps, and letting each poll
 * advance time would make the measured wait depend on how many polls happened to run. What the
 * drain DECIDED to wait is the assertion, and that is the last sleep it asked for. Each sleep
 * yields a macrotask so a loop polling on it cannot starve the test's own scheduling.
 */
function fakeClock(): DrainClock & { sleeps: number[]; advance: (ms: number) => void } {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    advance: (ms) => { t += ms; },
    sleep: async (ms) => { sleeps.push(ms); await new Promise<void>((r) => setImmediate(r)); },
  };
}

const lastSleep = (clock: { sleeps: number[] }): number => clock.sleeps[clock.sleeps.length - 1];

function connectionWith(source: FakeSource, clock: DrainClock): LiveKitConnection {
  // The session manager is never touched: no session is attached, so close() has nothing to unregister.
  return new LiveKitConnection(fakeRoom as never, source as never, {} as never, async () => {}, undefined, undefined, clock);
}

function pcm(ms: number, rate = 16000): Buffer {
  return Buffer.alloc(Math.floor((rate * ms) / 1000) * 2);
}

async function speak(conn: LiveKitConnection, ms: number, opts: { flushBuffer?: boolean } = {}): Promise<void> {
  await conn.sendMessage({ type: 'start_ai_generation_output', conversationId: 'c', outputTurnId: 't', expectVoice: true, flushBuffer: opts.flushBuffer } as never);
  await conn.sendMessage({ type: 'send_ai_voice_chunk', conversationId: 'c', outputTurnId: 't', audioData: pcm(ms), audioFormat: 'pcm_16000', chunkId: 'k', ordinal: 0, isFinal: true } as never);
}

describe('LiveKitConnection.drainOutbound', () => {
  it('waits out the audio the accounting says has not played, plus the carrier tail', async () => {
    const source = new FakeSource();
    const clock = fakeClock();
    const conn = connectionWith(source, clock);

    // 3,600ms of goodbye captured instantly: none of it can have played yet.
    await speak(conn, 3600);
    const drained = await conn.drainOutbound();

    expect(source.playoutWaits).to.equal(1);
    expect(drained.pushedMs).to.equal(3600);
    expect(drained.boundHit).to.equal(false);
    expect(lastSleep(clock)).to.equal(3600 + PSTN_TAIL_MS);
  });

  it('credits the time that has already elapsed since the first frame', async () => {
    const source = new FakeSource();
    const clock = fakeClock();
    const conn = connectionWith(source, clock);

    await speak(conn, 3600);
    clock.advance(3000); // most of it has had time to play
    const drained = await conn.drainOutbound();

    expect(drained.elapsedMs).to.equal(3000);
    expect(lastSleep(clock)).to.equal(600 + PSTN_TAIL_MS);
  });

  it('never drops the line before a chunk loop has finished handing over its frames', async () => {
    const source = new FakeSource();
    const clock = fakeClock();
    const conn = connectionWith(source, clock);

    let release!: () => void;
    source.gate = new Promise<void>((resolve) => { release = resolve; });

    // The chunk is in flight: its first frame is stuck behind the gate.
    const speaking = speak(conn, 1000);
    await new Promise((r) => setImmediate(r));

    let drainedYet = false;
    const drain = conn.drainOutbound().then((d) => { drainedYet = true; return d; });
    // Let the drain reach its wait on the in-flight loop.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(drainedYet, 'drain resolved while a chunk was still being pushed').to.equal(false);

    release();
    source.gate = null;
    await speaking;
    const drained = await drain;
    expect(drained.pushedMs).to.equal(1000);
    expect(source.captured.length).to.be.greaterThan(0);
  });

  it('is bounded, so a fault reads as a late hang-up and never a dead line', async () => {
    const source = new FakeSource();
    const clock = fakeClock();
    const conn = connectionWith(source, clock);

    await speak(conn, 60_000); // a minute of "audio" the accounting will insist is unplayed
    const drained = await conn.drainOutbound();

    expect(drained.boundHit).to.equal(true);
    expect(drained.waitedMs).to.be.at.most(DRAIN_BOUND_MS);
    expect(lastSleep(clock)).to.equal(DRAIN_BOUND_MS);
  });

  it('close() plays the goodbye out before leaving the room', async () => {
    // The runner closes the connection the instant it reaches `finished`, milliseconds after
    // conversation_end. Leaving the room stops the agent's audio at the caller's ear, so the
    // close itself has to wait - no other handler can protect the goodbye from it.
    const source = new FakeSource();
    const clock = fakeClock();
    const order: string[] = [];
    const origClose = source.close.bind(source);
    source.close = async () => { order.push('source-closed'); await origClose(); };
    const wrappedClock: DrainClock & { sleeps: number[]; advance: (ms: number) => void } = {
      ...clock,
      sleep: async (ms) => { order.push(`sleep-${ms}`); await clock.sleep(ms); },
    };
    const conn = connectionWith(source, wrappedClock);

    await speak(conn, 2000);
    await conn.close();

    const sleepIdx = order.indexOf(`sleep-${2000 + PSTN_TAIL_MS}`);
    const closeIdx = order.indexOf('source-closed');
    expect(sleepIdx, 'the goodbye wait never happened').to.be.greaterThan(-1);
    expect(sleepIdx).to.be.lessThan(closeIdx);
  });

  it('close({ drain: false }) leaves at once, for a caller who has already hung up', async () => {
    const source = new FakeSource();
    const clock = fakeClock();
    const conn = connectionWith(source, clock);

    await speak(conn, 2000);
    await conn.close({ drain: false });

    expect(clock.sleeps).to.deep.equal([]);
    expect(source.closed).to.equal(true);
  });

  it('does not pay the tail twice when a drain already covered this turn', async () => {
    const source = new FakeSource();
    const clock = fakeClock();
    const conn = connectionWith(source, clock);

    await speak(conn, 1000);
    await conn.drainOutbound();
    const sleepsAfterDrain = clock.sleeps.length;
    await conn.close();

    expect(clock.sleeps.length).to.equal(sleepsAfterDrain);
  });

  it('restarts the accounting on a fresh turn but not on a filler that continues into the reply', async () => {
    const source = new FakeSource();
    const clock = fakeClock();
    const conn = connectionWith(source, clock);

    await speak(conn, 500, { flushBuffer: false }); // filler
    await speak(conn, 1500, { flushBuffer: false }); // reply joins it
    let drained = await conn.drainOutbound();
    expect(drained.pushedMs).to.equal(2000);

    await speak(conn, 700); // a new turn
    drained = await conn.drainOutbound();
    expect(drained.pushedMs).to.equal(700);
  });
});
