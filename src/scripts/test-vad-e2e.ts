import { readFileSync } from 'fs';
import { FireRedVadWrapper } from '../services/audio/FireRedVadWrapper';

async function testChunked(name: string, pcmPath: string, chunkDesc: string, chunkFn: (raw: Buffer) => Buffer[]) {
  const raw = readFileSync(pcmPath);
  let audioLen = 0;
  let segCount = 0;

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
    onSpeechEnd: (audio) => {
      segCount++;
      audioLen = audio.length;
    },
  });

  await wrapper.init();
  const chunks = chunkFn(raw);

  for (const chunk of chunks) {
    wrapper.processAudio(chunk);
  }
  await wrapper.flush();

  console.log(`  ${chunkDesc}: ${segCount} segment(s), ${audioLen} samples`);
  wrapper.destroy();
  return audioLen;
}

async function testAudio(name: string, pcmPath: string, expectedSamples: number) {
  console.log(`\n${name}:`);

  const len1 = await testChunked(name, pcmPath, 'all-at-once', (r) => [r]);
  const len2 = await testChunked(name, pcmPath, '320B chunks', (r) => {
    const c: Buffer[] = [];
    for (let i = 0; i < r.length; i += 320) c.push(Buffer.from(r.subarray(i, i + 320)));
    return c;
  });
  const len3 = await testChunked(name, pcmPath, 'random chunks', (r) => {
    const c: Buffer[] = [];
    let pos = 0;
    while (pos < r.length) {
      const sz = Math.min(r.length - pos, 64 + Math.floor(Math.random() * 640));
      c.push(Buffer.from(r.subarray(pos, pos + sz)));
      pos += sz;
    }
    return c;
  });
  const len4 = await testChunked(name, pcmPath, 'unaligned chunks', (r) => {
    const c: Buffer[] = [];
    for (let i = 0; i < r.length; i += 127) c.push(Buffer.from(r.subarray(i, i + 127)));
    return c;
  });

  const allMatch = [len1, len2, len3, len4].every(l => Math.abs(l - expectedSamples) <= 320);
  console.log(`  Expected: ~${expectedSamples} samples. PASS: ${allMatch}`);
}

async function main() {
  await testAudio('Joe', '/tmp/joe.pcm', 24000);
  await testAudio('UH', '/tmp/uh.pcm', 25600);
}

main().catch((err) => { console.error(err); process.exit(1); });
