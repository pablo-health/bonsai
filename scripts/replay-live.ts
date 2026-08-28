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
  const heard: string[] = [];
  const said: string[] = [];
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
      const text = m.text ?? m.transcript ?? m.data?.text;
      if (typeof text === 'string' && text.trim()) {
        if (m.type?.includes('user') || m.role === 'user') heard.push(text);
        else if (m.role === 'assistant' || m.type?.includes('ai')) said.push(text);
      }
    });
    ws.on('close', () => resolve());
  });

  console.log(JSON.stringify({ conversationId, caller: heard, agent: said }, null, 1));
}

main().then(() => process.exit(0)).catch((e) => { console.error(String(e)); process.exit(1); });
