import { readFile } from 'fs/promises';
import * as path from 'path';
import * as ort from 'onnxruntime-node';

async function main() {
  const session = await ort.InferenceSession.create(path.join(process.cwd(), 'models/firered-vad/fireredvad_stream_vad_with_cache.onnx'));
  console.log('Input names:', session.inputNames);
  console.log('Output names:', session.outputNames);

  // Test with zero features
  const feat0 = new Float32Array(80).fill(0);
  const cache0 = new Float32Array(8 * 1 * 128 * 19).fill(0);
  const r0 = await session.run({
    feat: new ort.Tensor('float32', feat0, [1, 1, 80]),
    caches_in: new ort.Tensor('float32', cache0, [8, 1, 128, 19]),
  });
  console.log('Zero input prob:', (r0.probs.data as Float32Array)[0]);

  // Test with 0.5 features
  const feat1 = new Float32Array(80).fill(0.5);
  const cache1 = new Float32Array(8 * 1 * 128 * 19).fill(0);
  const r1 = await session.run({
    feat: new ort.Tensor('float32', feat1, [1, 1, 80]),
    caches_in: new ort.Tensor('float32', cache1, [8, 1, 128, 19]),
  });
  console.log('0.5 input prob:', (r1.probs.data as Float32Array)[0]);

  // Test with -6.5 features (typical silent)
  const feat2 = new Float32Array(80).fill(-6.5);
  const cache2 = new Float32Array(8 * 1 * 128 * 19).fill(0);
  const r2 = await session.run({
    feat: new ort.Tensor('float32', feat2, [1, 1, 80]),
    caches_in: new ort.Tensor('float32', cache2, [8, 1, 128, 19]),
  });
  console.log('-6.5 input prob:', (r2.probs.data as Float32Array)[0]);

  // Test with actual audio frame
  const raw = await readFile('/tmp/joe.pcm');
  const pcm16 = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  const pcm = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) pcm[i] = pcm16[i] / 32768;

  // Frame 104 (expected speech start)
  const frame = pcm.subarray(104 * 160, 104 * 160 + 400);
  console.log('Frame 104 range:', Math.min(...frame), Math.max(...frame));
  console.log('Frame 104 mean:', frame.reduce((a, b) => a + b, 0) / frame.length);

  // Frame 0 (silent)
  const frame0 = pcm.subarray(0, 400);
  console.log('Frame 0 range:', Math.min(...frame0), Math.max(...frame0));
  console.log('Frame 0 mean:', frame0.reduce((a, b) => a + b, 0) / frame0.length);

  await session.release();
}

main().catch((err) => { console.error(err); process.exit(1); });
