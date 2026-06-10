import { readFile } from 'fs/promises';

async function main() {
  const raw = await readFile('/tmp/joe.pcm');
  const pcm16 = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  const pcm = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) pcm[i] = pcm16[i] / 32768;

  // Energy per frame
  const frameLength = 400;
  const frameShift = 160;
  const nFrames = Math.floor((pcm.length - frameLength) / frameShift) + 1;

  console.log('Frame | Energy (mean abs) | Min | Max');
  console.log('------|-------------------|-----|-----');
  for (let f = 0; f < nFrames; f += 10) {
    const start = f * frameShift;
    const frame = pcm.subarray(start, start + frameLength);
    let energy = 0;
    let minVal = Infinity, maxVal = -Infinity;
    for (let i = 0; i < frameLength; i++) {
      energy += Math.abs(frame[i]);
      if (frame[i] < minVal) minVal = frame[i];
      if (frame[i] > maxVal) maxVal = frame[i];
    }
    console.log(`  ${f}   |        ${(energy/frameLength).toFixed(4)}       | ${(minVal).toFixed(4)} | ${(maxVal).toFixed(4)}`);
  }
}

main();
