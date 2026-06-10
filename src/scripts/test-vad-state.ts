import { FireRedVadWrapper, preloadFireRedVad } from '../services/audio/FireRedVadWrapper';

function genSpeech(sr: number, start: number, end: number, arr: Int16Array) {
  for (let i = Math.round(start * sr); i < Math.round(end * sr); i++) {
    const t = i / sr;
    const f0 = Math.sin(2 * Math.PI * 120 * t);
    const f1 = Math.sin(2 * Math.PI * 500 * t) * 0.5;
    const f2 = Math.sin(2 * Math.PI * 1500 * t) * 0.3;
    const f3 = Math.sin(2 * Math.PI * 2500 * t) * 0.15;
    arr[i] = Math.round(15000 * f0 * (1 + f1 + f2 + f3));
  }
}

async function test(name: string, samples: Int16Array) {
  console.log(`\n=== ${name} ===`);
  const segs: { start: number; end: number }[] = [];
  let frameCount = 0;
  const wrapper = new FireRedVadWrapper(16000, {
    speechThreshold: 0.5,
    smoothWindowSize: 5,
    minSpeechFrame: 8,
    maxSpeechFrame: 2000,
    minSilenceFrame: 20,
    padStartFrame: 5,
    gracePeriodMs: 0,
  }, {
    onSpeechStart: () => {
      const t = (frameCount * 0.01).toFixed(2);
      console.log(`  SPEECH START @ ${t}s`);
      segs.push({ start: frameCount, end: -1 });
    },
    onSpeechEnd: () => {
      const t = (frameCount * 0.01).toFixed(2);
      console.log(`  SPEECH END   @ ${t}s`);
      if (segs.length) segs[segs.length - 1].end = frameCount;
    },
  });
  await wrapper.init();

  for (let i = 0; i < samples.length; i += 160) {
    const end = Math.min(i + 320, samples.length);
    const chunk = samples.slice(i, end);
    if (chunk.length === 320) {
      const buf = Buffer.allocUnsafe(chunk.length * 2);
      for (let j = 0; j < chunk.length; j++) buf.writeInt16LE(chunk[j], j * 2);
      wrapper.processAudio(buf);
      frameCount++;
    }
  }
  await wrapper.flush();
  wrapper.destroy();
  for (const s of segs) {
    const start = s.start >= 0 ? (s.start * 0.01).toFixed(2) : '?';
    const end = s.end >= 0 ? (s.end * 0.01).toFixed(2) : '?';
    console.log(`  Segment: ${start}s - ${end}s`);
  }
}

async function main() {
  await preloadFireRedVad();

  // Two bursts, 0.5s gap (50 frames)
  {
    const arr = new Int16Array(16000 * 4);
    genSpeech(16000, 0.2, 0.8, arr);
    genSpeech(16000, 1.3, 1.9, arr);
    await test('Gap 0.5s: speech 0.2-0.8 + 1.3-1.9', arr);
  }

  // Two bursts, 1.5s gap (150 frames)
  {
    const arr = new Int16Array(16000 * 6);
    genSpeech(16000, 0.2, 0.8, arr);
    genSpeech(16000, 2.3, 2.9, arr);
    await test('Gap 1.5s: speech 0.2-0.8 + 2.3-2.9', arr);
  }

  // Two bursts, 3s gap
  {
    const arr = new Int16Array(16000 * 8);
    genSpeech(16000, 0.2, 0.8, arr);
    genSpeech(16000, 4.3, 4.9, arr);
    await test('Gap 3.5s: speech 0.2-0.8 + 4.3-4.9', arr);
  }
}

main().catch(console.error);
