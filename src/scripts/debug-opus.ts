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

    const probs: number[] = [];
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
      probs.push(rawProb);
      return origProcess(rawProb);
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
    const minProb = Math.min(...probs);
    const maxProb = Math.max(...probs);
    const speechFrames = probs.filter(p => p >= 0.5).length;
    console.log(`${fname}: ${duration.toFixed(2)}s | ${numFrames} frames | probs: min=${minProb.toFixed(4)} max=${maxProb.toFixed(4)} speech=${speechFrames}/${probs.length}`);

    wrapper.destroy();
  } finally {
    unlinkSync(pcmPath);
  }
}

async function main() {
  await processOneFile('/home/patryk/Downloads/user_voice_2026-05-25-16-29-58.opus');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
