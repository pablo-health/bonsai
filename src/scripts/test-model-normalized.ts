import { readFile } from 'fs/promises';
import * as path from 'path';
import * as ort from 'onnxruntime-node';

async function parseCmvn(filePath: string) {
  const buffer = await readFile(filePath);
  let offset = 0;
  offset = buffer.indexOf(0x20, offset) + 1;
  offset += 1;
  const rows = buffer.readInt32LE(offset);
  offset += 4;
  offset += 1;
  const cols = buffer.readInt32LE(offset);
  offset += 4;
  const dim = cols - 1;
  const matrix = new Float64Array(rows * cols);
  for (let i = 0; i < rows * cols; i++) {
    matrix[i] = buffer.readDoubleLE(offset);
    offset += 8;
  }
  const count = matrix[dim];
  const means = new Float32Array(dim);
  const inverseStdVariances = new Float32Array(dim);
  for (let d = 0; d < dim; d++) {
    const mean = matrix[d] / count;
    const sos = matrix[dim + 1 + d];
    const variance = sos / count - mean * mean;
    const v = variance < 1e-20 ? 1e-20 : variance;
    means[d] = mean;
    inverseStdVariances[d] = 1.0 / Math.sqrt(v);
  }
  return { means, inverseStdVariances };
}

function melScaleHtk(freq: number): number { return 1127.0 * Math.log(1.0 + freq / 700.0); }
function invMelScaleHtk(mel: number): number { return 700.0 * (Math.exp(mel / 1127.0) - 1.0); }

function createFilterbank(sampleRate: number, numBins: number, fftSize: number) {
  const numFreqBins = fftSize / 2 + 1;
  const fftBinWidth = sampleRate / fftSize;
  const melLow = melScaleHtk(20);
  const melHigh = melScaleHtk(sampleRate / 2);
  const melDelta = (melHigh - melLow) / (numBins + 1);
  const fb = new Float32Array(numBins * numFreqBins);
  for (let bin = 0; bin < numBins; bin++) {
    const leftMel = melLow + bin * melDelta;
    const centerMel = melLow + (bin + 1) * melDelta;
    const rightMel = melLow + (bin + 2) * melDelta;
    const leftHz = invMelScaleHtk(leftMel);
    const centerHz = invMelScaleHtk(centerMel);
    const rightHz = invMelScaleHtk(rightMel);
    for (let i = 0; i < numFreqBins; i++) {
      const hz = fftBinWidth * i;
      if (hz > leftHz && hz < rightHz) {
        let weight: number;
        if (hz <= centerHz) weight = (hz - leftHz) / (centerHz - leftHz);
        else weight = (rightHz - hz) / (rightHz - centerHz);
        weight *= 2.0 / (rightHz - leftHz);
        fb[bin * numFreqBins + i] = weight;
      }
    }
  }
  return fb;
}

function createPoveyWindow(size: number): Float32Array {
  const w = new Float32Array(size);
  const a = 2 * Math.PI / (size - 1);
  for (let i = 0; i < size; i++) w[i] = Math.pow(0.5 - 0.5 * Math.cos(a * i), 0.85);
  return w;
}

function rfft(data: Float64Array, n: number): void {
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let j = 0;
    for (let b = 0; b < bits; b++) j = (j << 1) | ((i >> b) & 1);
    if (i < j) {
      const tmp = data[i * 2]; data[i * 2] = data[j * 2]; data[j * 2] = tmp;
      const tmpIm = data[i * 2 + 1]; data[i * 2 + 1] = data[j * 2 + 1]; data[j * 2 + 1] = tmpIm;
    }
  }
  for (let len = 2; len <= n; len *= 2) {
    const halfLen = len / 2, angleStep = -2 * Math.PI / len;
    const wReal = Math.cos(angleStep), wImag = Math.sin(angleStep);
    for (let i = 0; i < n; i += len) {
      let wRe = 1, wIm = 0;
      for (let j = 0; j < halfLen; j++) {
        const uRe = data[(i + j) * 2], uIm = data[(i + j) * 2 + 1];
        const vRe = data[(i + j + halfLen) * 2] * wRe - data[(i + j + halfLen) * 2 + 1] * wIm;
        const vIm = data[(i + j + halfLen) * 2] * wIm + data[(i + j + halfLen) * 2 + 1] * wRe;
        data[(i + j) * 2] = uRe + vRe; data[(i + j) * 2 + 1] = uIm + vIm;
        data[(i + j + halfLen) * 2] = uRe - vRe; data[(i + j + halfLen) * 2 + 1] = uIm - vIm;
        const nwRe = wRe * wReal - wIm * wImag;
        wIm = wRe * wImag + wIm * wReal; wRe = nwRe;
      }
    }
  }
}

function extractFrame(pcm: Float32Array, start: number, fb: Float32Array, win: Float32Array, means: Float32Array, istd: Float32Array, fl: number, fs: number, nb: number, nfb: number): Float32Array {
  const frame = new Float32Array(pcm.subarray(start, start + fl));
  let dcSum = 0;
  for (let i = 0; i < fl; i++) dcSum += frame[i];
  const dcMean = dcSum / fl;
  for (let i = 0; i < fl; i++) frame[i] -= dcMean;
  for (let i = fl - 1; i > 0; i--) frame[i] -= 0.97 * frame[i - 1];
  frame[0] -= 0.97 * frame[0];
  const complex = new Float64Array(fs * 2);
  for (let i = 0; i < fl; i++) complex[i * 2] = frame[i] * win[i];
  rfft(complex, fs);
  const power = new Float32Array(nfb);
  for (let i = 0; i <= fs / 2; i++) {
    const re = complex[i * 2], im = complex[i * 2 + 1];
    power[i] = re * re + im * im;
  }
  const fbank = new Float32Array(nb);
  for (let m = 0; m < nb; m++) {
    let sum = 0;
    const base = m * nfb;
    for (let i = 0; i < nfb; i++) sum += fb[base + i] * power[i];
    fbank[m] = sum;
  }
  for (let m = 0; m < nb; m++) fbank[m] = Math.log(Math.max(fbank[m], 1.192e-7));
  for (let m = 0; m < nb; m++) fbank[m] = (fbank[m] - means[m]) * istd[m];
  return fbank;
}

async function main() {
  const raw = await readFile('/tmp/joe.pcm');
  const pcm16 = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);

  let maxAbs = 0;
  for (let i = 0; i < pcm16.length; i++) {
    const a = Math.abs(pcm16[i]);
    if (a > maxAbs) maxAbs = a;
  }

  const pcm = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) pcm[i] = (pcm16[i] / maxAbs) * 0.75;

  const cmvnData = await parseCmvn(path.join(process.cwd(), 'models/firered-vad/cmvn.ark'));
  const sampleRate = 16000, frameLength = 400, frameShift = 160, fftSize = 512, numBins = 80, numFreqBins = fftSize / 2 + 1;
  const filterbank = createFilterbank(sampleRate, numBins, fftSize);
  const window = createPoveyWindow(frameLength);

  const session = await ort.InferenceSession.create(path.join(process.cwd(), 'models/firered-vad/fireredvad_stream_vad_with_cache.onnx'));
  const nFrames = Math.floor((pcm.length - frameLength) / frameShift) + 1;
  const cache = new Float32Array(8 * 1 * 128 * 19).fill(0);
  const probs: number[] = [];

  for (let f = 0; f < nFrames; f++) {
    const feat = extractFrame(pcm, f * frameShift, filterbank, window, cmvnData.means, cmvnData.inverseStdVariances, frameLength, fftSize, numBins, numFreqBins);
    const result = await session.run({
      feat: new ort.Tensor('float32', feat, [1, 1, numBins]),
      caches_in: new ort.Tensor('float32', cache, [8, 1, 128, 19]),
    });
    probs.push((result.probs.data as Float32Array)[0]);
    cache.set(result.caches_out.data as Float32Array);
  }

  const maxIdx = probs.indexOf(Math.max(...probs));
  console.log(`Max prob: ${probs[maxIdx].toFixed(4)} at frame ${maxIdx}`);

  const speechFrames = probs.map((p, i) => ({ frame: i, prob: p })).filter(x => x.prob > 0.5);
  console.log('Frames with prob > 0.5:', speechFrames.length);

  console.log('\nFrame | Prob  | Energy');
  console.log('------|-------|--------');
  for (let f = 0; f < nFrames; f += 5) {
    const start = f * frameShift;
    const frame = pcm.subarray(start, start + frameLength);
    let energy = 0;
    for (let i = 0; i < frameLength; i++) energy += Math.abs(frame[i]);
    console.log(`  ${f}   | ${(probs[f]).toFixed(4)} | ${(energy/frameLength).toFixed(4)}`);
  }

  await session.release();
}

main().catch((err) => { console.error(err); process.exit(1); });
