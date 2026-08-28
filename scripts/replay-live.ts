/**
 * Feeds a recorded call's audio into a LIVE conversation, over Bonsai's own client protocol.
 *
 * The offline harness (replay-asr.ts) drives the recogniser alone: one clean session, no VAD, no
 * turn-taking. It reports the best that recogniser could do with the audio, which is a ceiling
 * rather than a reality - and it beats the live call every time, which is exactly the thing that
 * needed explaining.
 *
 * This drives the whole conversation runtime instead: the VAD segments the audio, the ASR session
 * is started, pre-warmed, reset and stopped by the same code a caller triggers, and the turn
 * machinery runs. The audio arrives as the identical bytes the recorder captured, because
 * send_user_voice_chunk lands in receiveUserVoiceData - the same function the recorder taps. No
 * codec, no re-encode, nothing lost. Dialling in over the PSTN would have cost a second encode
 * for coverage of a layer we do not yet suspect.
 *
 * Usage:
 *   tsx scripts/replay-live.ts --file call.raw --api-key akey_... [--offset N] [--length N]
 */
import { promises as fs } from 'fs';
import WebSocket from 'ws';

const SR = 16000, BPS = 2;
const CHUNK_MS = 100;
const CHUNK_BYTES = (SR * BPS * CHUNK_MS) / 1000;

const arg = (n: string): string | undefined => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

async function main(): Promise<void> {
  const file = arg('file')!;
  const apiKey = arg('api-key')!;
  const url = arg('url') ?? 'ws://127.0.0.1:3000/ws';

  const whole = await fs.readFile(file);
  const offset = Number(arg('offset') ?? 0);
  const audio = whole.subarray(offset, offset + Number(arg('length') ?? whole.length - offset));

  const ws = new WebSocket(url);
  const deadlineMs = Number(arg('deadline-ms') ?? 120000);
  const deadline = setTimeout(() => {
    console.error(`deadline of ${deadlineMs}ms reached; closing`);
    try { ws.close(); } catch { /* already gone */ }
  }, deadlineMs);
  deadline.unref?.();
  /** Turns as SUBMITTED - one entry per user turn the runtime acted on. */
  const heard: string[] = [];
  const said: string[] = [];
  /**
   * Individual finals as they arrived, which is not the same list.
   *
   * Kept apart because the difference between them is the open question in THERAPY-b5xwm.40: a
   * turn reading "Kirk. Kirk." is two finals, and whether that is the caller saying it twice or
   * the same audio counted twice is exactly what merging the two lists hides.
   */
  const chunks: string[] = [];
  let sessionId = '';
  let conversationId = '';
  let ordinal = 0;

  const send = (m: Record<string, unknown>) => ws.send(JSON.stringify(m));

  await new Promise<void>((resolve, reject) => {
    ws.on('error', reject);
    ws.on('open', () => {
      send({
        requestId: 'r1', type: 'auth', apiKey,
        sessionSettings: {
          sendVoiceInput: true, sendTextInput: false,
          // No TTS back: it costs money, adds nothing here, and its absence cannot change what
          // the recogniser makes of the caller's audio.
          receiveVoiceOutput: false, receiveTranscriptionUpdates: true, receiveEvents: true,
          sendAudioFormat: 'pcm_16000',
        },
      });
    });

    ws.on('message', async (raw: Buffer) => {
      const m = JSON.parse(raw.toString());
      if (process.argv.includes('--debug')) {
        const preview = JSON.stringify(m).slice(0, 220);
        console.error(`<- ${m.type ?? '?'}  ${preview}`);
      }
      if (m.type === 'auth' && m.success) {
        sessionId = m.sessionId;
        send({
          requestId: 'r2', type: 'start_conversation', sessionId,
          userId: arg('user-id') ?? '+14047544201',
          // The project sets no default startingStageId, so the stage is explicit here. It is
          // also the knob that lets a fixture stage stand in for the real one.
          ...(arg('stage-id') ? { stageId: arg('stage-id') } : {}),
        });
        return;
      }
      if (m.type === 'start_conversation' || m.type === 'conversation_started') {
        // Streaming audio into a session with no conversation produces one error per frame and
        // no information. Fail loudly instead.
        if (m.success === false) {
          console.error(`start_conversation failed: ${m.error}`);
          ws.close();
          return reject(new Error(m.error));
        }
        conversationId = m.conversationId ?? conversationId;
        // Stream at wall-clock speed: the VAD and the endpoint classifier both work on timing,
        // and pushing faster than real time asks them a different question.
        for (let at = 0; at < audio.length; at += CHUNK_BYTES) {
          send({
            requestId: `a${ordinal}`, type: 'send_user_voice_chunk', sessionId,
            audioData: audio.subarray(at, Math.min(at + CHUNK_BYTES, audio.length)).toString('base64'),
            ordinal: ordinal++,
          });
          await new Promise((r) => setTimeout(r, CHUNK_MS));
        }
        // Let the last turn finish being recognised before hanging up on ourselves.
        await new Promise((r) => setTimeout(r, 6000));
        send({ requestId: 'rz', type: 'end_conversation', sessionId });
        setTimeout(() => { ws.close(); resolve(); }, 1500);
        return;
      }
      // Read the shapes the server actually sends, rather than guessing at a `text` field.
      //
      // This collected nothing for a day. It looked for `m.text`, and the server sends the
      // caller's words as `chunkText` on a user_transcribed_chunk and the agent's as
      // `eventData.text` inside a conversation_event - so every run printed empty arrays for a
      // call that had plainly happened, and the first intake replay was read as a total failure
      // until the database was queried by hand. An instrument that reports nothing when it
      // worked is worse than one that reports nothing at all, because the empty result reads as
      // evidence.
      if (m.type === 'user_transcribed_chunk' && m.isFinal && typeof m.chunkText === 'string' && m.chunkText.trim()) {
        chunks.push(m.chunkText.trim());
        return;
      }
      if (m.type === 'conversation_event' && m.eventType === 'message') {
        const event = m.eventData ?? {};
        if (typeof event.text === 'string' && event.text.trim()) {
          (event.role === 'user' ? heard : said).push(event.text.trim());
        }
      }
    });
    ws.on('close', () => resolve());
  });

  console.log(JSON.stringify({ conversationId, caller: heard, agent: said, callerChunks: chunks }, null, 1));

  // A run that collected nothing is a broken rig, not a silent call, and the two must not look
  // alike from the outside.
  if (heard.length === 0 && said.length === 0 && chunks.length === 0) {
    console.error('collected no transcript at all - the rig is broken, not the call');
    process.exitCode = 1;
  }
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(String(e)); process.exit(1); });
