import { readFile } from 'fs/promises';
import { FireRedVadWrapper } from '../services/audio/FireRedVadWrapper';

async function main() {
  const raw = await readFile('/tmp/test_opus.pcm');
  const pcm16 = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  let minVal = Infinity, maxVal = -Infinity;
  for (let i = 0; i < pcm16.length; i++) {
    if (pcm16[i] < minVal) minVal = pcm16[i];
    if (pcm16[i] > maxVal) maxVal = pcm16[i];
  }
  console.log(`test_opus.pcm: samples=${pcm16.length}, range=[${minVal}, ${maxVal}], duration=${(pcm16.length / 16000).toFixed(2)}s`);

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

  const buf = Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
  wrapper.processAudio(buf);
  await wrapper.flush();

  console.log('Segments:', JSON.stringify(segments));
  wrapper.destroy();
}

main().catch((err) => { console.error(err); process.exit(1); });
