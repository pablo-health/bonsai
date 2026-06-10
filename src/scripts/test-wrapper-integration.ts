import { readFile } from 'fs/promises';
import * as path from 'path';
import { FireRedVadWrapper } from '../services/audio/FireRedVadWrapper';

async function main() {
  const raw = await readFile('/tmp/joe.pcm');
  const pcm16 = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  console.log('PCM samples:', pcm16.length);

  const config = {
    speechThreshold: 0.5,
    smoothWindowSize: 5,
    minSpeechFrame: 8,
    maxSpeechFrame: 2000,
    minSilenceFrame: 20,
    padStartFrame: 5,
    gracePeriodMs: 0,
  };

  const segments: Array<{ start: number; end: number }> = [];
  const wrapper = new FireRedVadWrapper(16000, config, {
    onSpeechStart: () => {
      const startFrame = wrapper['stateMachine']['currentFrameCnt'];
      segments.push({ start: startFrame, end: -1 });
      console.log(`Speech start at frame ${startFrame}`);
    },
    onSpeechEnd: (audio: Float32Array) => {
      const endFrame = wrapper['stateMachine']['currentFrameCnt'];
      if (segments.length > 0) segments[segments.length - 1].end = endFrame;
      console.log(`Speech end at frame ${endFrame}, audio samples: ${audio.length}`);
    },
  });

  await wrapper.init();
  await wrapper.initResampler(16000);

  // Feed all audio
  const buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  wrapper.processAudio(buf);

  await wrapper.flush();

  console.log('Segments:', JSON.stringify(segments));
  console.log('Expected: [[104, 249]]');
  wrapper.destroy();
}

main().catch((err) => { console.error(err); process.exit(1); });
