import { readFile } from 'fs/promises';
import { FireRedVadWrapper } from '../services/audio/FireRedVadWrapper';

async function main() {
  const raw = await readFile('/tmp/joe.pcm');
  const pcm16 = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);

  // Normalize to -1.0 .. +1.0 range
  let maxAbs = 0;
  for (let i = 0; i < pcm16.length; i++) {
    const a = Math.abs(pcm16[i]);
    if (a > maxAbs) maxAbs = a;
  }
  console.log('Original max abs:', maxAbs);

  const normalized = new Int16Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    const v = pcm16[i] / maxAbs;
    normalized[i] = Math.max(-32768, Math.min(32767, Math.round(v * 25000)));
  }
  console.log('Normalized max abs:', Math.max(...Array.from(normalized).map(Math.abs)));

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

  const buf = Buffer.from(normalized.buffer, normalized.byteOffset, normalized.byteLength);
  wrapper.processAudio(buf);
  await wrapper.flush();

  console.log('Segments:', JSON.stringify(segments));
  wrapper.destroy();
}

main().catch((err) => { console.error(err); process.exit(1); });
