import { readFileSync } from 'fs';
import { FireRedVadWrapper } from '../services/audio/FireRedVadWrapper';

const raw = readFileSync('/tmp/joe.pcm');
const CHUNK_SIZE = 320;

async function runWithConfig(config: {
  speechThreshold?: number;
  smoothWindowSize?: number;
  minSpeechFrame?: number;
  maxSpeechFrame?: number;
  minSilenceFrame?: number;
  padStartFrame?: number;
  gracePeriodMs?: number;
}): Promise<number> {
  const merged = {
    speechThreshold: 0.5,
    smoothWindowSize: 5,
    minSpeechFrame: 8,
    maxSpeechFrame: 2000,
    minSilenceFrame: 20,
    padStartFrame: 5,
    gracePeriodMs: 0,
    ...config,
  };

  let audioLen = 0;
  const wrapper = new FireRedVadWrapper(16000, merged, {
    onSpeechStart: () => {},
    onSpeechEnd: (audio) => { audioLen = audio.length; },
  });

  await wrapper.init();
  for (let i = 0; i < raw.length; i += CHUNK_SIZE) {
    wrapper.processAudio(Buffer.from(raw.subarray(i, i + CHUNK_SIZE)));
  }
  await wrapper.flush();
  wrapper.destroy();
  return audioLen;
}

async function main() {
  console.log('=== padStartFrame (with smoothWindowSize=1 to avoid clamp) ===');
  const pad0 = await runWithConfig({ padStartFrame: 0, smoothWindowSize: 1 });
  const pad5 = await runWithConfig({ padStartFrame: 5, smoothWindowSize: 1 });
  const pad10 = await runWithConfig({ padStartFrame: 10, smoothWindowSize: 1 });
  const pad20 = await runWithConfig({ padStartFrame: 20, smoothWindowSize: 1 });
  console.log(`  pad 0:  ${pad0} samples (${pad0 / 160} frames)`);
  console.log(`  pad 5:  ${pad5} samples (${pad5 / 160} frames) — diff from pad 0: ${pad5 - pad0}`);
  console.log(`  pad 10: ${pad10} samples (${pad10 / 160} frames) — diff from pad 5: ${pad10 - pad5}`);
  console.log(`  pad 20: ${pad20} samples (${pad20 / 160} frames) — diff from pad 10: ${pad20 - pad10}`);
  console.log(`  Each +5 pad adds ~800 samples: ${pad5 - pad0 === 800 && pad10 - pad5 === 800 && pad20 - pad10 === 800 ? 'YES' : 'NO'}`);

  console.log('\n=== gracePeriodMs (speech starts at frame ~104 = ~1s) ===');
  const g0 = await runWithConfig({ gracePeriodMs: 0 });
  const g500 = await runWithConfig({ gracePeriodMs: 500 });
  const g1000 = await runWithConfig({ gracePeriodMs: 1000 });
  const g2000 = await runWithConfig({ gracePeriodMs: 2000 });
  console.log(`  grace 0ms:   ${g0} samples`);
  console.log(`  grace 500ms: ${g500} samples`);
  console.log(`  grace 1000ms: ${g1000} samples`);
  console.log(`  grace 2000ms: ${g2000} samples`);

  // With grace period longer than speech start time, speech should be suppressed entirely
  const g5000 = await runWithConfig({ gracePeriodMs: 5000 });
  console.log(`  grace 5000ms: ${g5000} samples (should be 0 — speech suppressed)`);

  console.log('\n=== Combined settings ===');
  const combined = await runWithConfig({
    speechThreshold: 0.3,
    smoothWindowSize: 3,
    minSpeechFrame: 4,
    minSilenceFrame: 10,
    padStartFrame: 10,
  });
  console.log(`  Custom config: ${combined} samples`);
}

main().catch((err) => { console.error(err); process.exit(1); });
