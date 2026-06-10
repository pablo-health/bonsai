import { FireRedVadWrapper } from '../services/audio/FireRedVadWrapper.js';
import { readFile } from 'fs/promises';
import { execSync } from 'child_process';
import { mkdtempSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

async function opusToPcm(opusPath: string): Promise<string> {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'opus-'));
  const pcmPath = path.join(tmpDir, 'audio.pcm');
  execSync(`ffmpeg -y -i "${opusPath}" -f s16le -ar 16000 -ac 1 "${pcmPath}"`, { stdio: 'pipe' });
  return pcmPath;
}

async function processOneFile(opusPath: string): Promise<void> {
  const fname = path.basename(opusPath);
  const pcmPath = await opusToPcm(opusPath);

  try {
    const raw = await readFile(pcmPath);
    const pcm16 = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);

    const segments: Array<[number, number]> = [];
    const wrapper = new FireRedVadWrapper(16000, {
      speechThreshold: 0.5,
      smoothWindowSize: 5,
      minSpeechFrame: 8,
      maxSpeechFrame: 2000,
      minSilenceFrame: 20,
      padStartFrame: 5,
      gracePeriodMs: 0,
    }, {
      onSpeechStart: () => {},
      onSpeechEnd: () => {},
    });

    await wrapper.init();

    const sm = (wrapper as any)['stateMachine'];
    const origProcess = sm.processOneFrame.bind(sm);
    sm.processOneFrame = function (rawProb: number) {
      const result = origProcess(rawProb);
      if (result.isSpeechEnd) {
        segments.push([result.speechStartFrame, result.speechEndFrame]);
      }
      return result;
    };

    for (let i = 0; i < pcm16.length - 159; i += 160) {
      const chunk = pcm16.subarray(i, i + 160);
      const buf = Buffer.alloc(chunk.length * 2);
      for (let j = 0; j < chunk.length; j++) {
        buf.writeInt16LE(chunk[j], j * 2);
      }
      wrapper.processAudio(buf);
    }
    await wrapper.flush();

    const duration = pcm16.length / 16000;
    const numFrames = Math.floor((pcm16.length - 400) / 160) + 1;
    console.log(`${fname}: ${duration.toFixed(2)}s | ${numFrames} frames | TS: ${JSON.stringify(segments)}`);

    wrapper.destroy();
  } finally {
    unlinkSync(pcmPath);
  }
}

async function main() {
  const files = [
    '/home/patryk/Downloads/user_voice_2026-05-25-16-29-58.opus',
    '/home/patryk/Downloads/user_voice_2026-05-26-08-33-44.opus',
    '/home/patryk/Downloads/user_voice_2026-05-26-09-18-03.opus',
    '/home/patryk/Downloads/user_voice_2026-05-27-09-35-50.opus',
    '/home/patryk/Downloads/user_voice_2026-05-27-14-48-08.opus',
    '/home/patryk/Downloads/user_voice_2026-06-10-11-27-07.opus',
  ];

  for (const f of files) {
    await processOneFile(f);
    if (global.gc) global.gc();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
