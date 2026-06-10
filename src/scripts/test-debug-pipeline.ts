import { readFile } from 'fs/promises';
import * as path from 'path';
import * as ort from 'onnxruntime-node';

const PCM_PATH = '/tmp/joe.pcm';
const CMVN_PATH = path.join(process.cwd(), 'models/firered-vad/cmvn.ark');

async function parseCmvn(filePath: string) {
  const buffer = await readFile(filePath);
  let offset = 0;
  const keyEnd = buffer.indexOf(0x20, offset);
  offset = keyEnd + 1;
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

function melScaleHtk(freq: number): number {
  return 1127.0 * Math.log(1.0 + freq / 700.0);
}

function invMelScaleHtk(mel: number): number {
  return 700.0 * (Math.exp(mel / 1127.0) - 1.0);
}

function createFilterbank(sampleRate: number, numBins: number, fftSize: number) {
  const numFreqBins = fftSize / 2 + 1;
  const fftBinWidth = sampleRate / fftSize;
  const lowFreq = 20;
  const highFreq = sampleRate / 2;
  const melLow = melScaleHtk(lowFreq);
  const melHigh = melScaleHtk(highFreq);
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
  const window = new Float32Array(size);
  const a = 2 * Math.PI / (size - 1);
  for (let i = 0; i < size; i++) window[i] = Math.pow(0.5 - 0.5 * Math.cos(a * i), 0.85);
  return window;
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
    const halfLen = len / 2;
    const angleStep = -2 * Math.PI / len;
    const wReal = Math.cos(angleStep);
    const wImag = Math.sin(angleStep);
    for (let i = 0; i < n; i += len) {
      let wRe = 1, wIm = 0;
      for (let j = 0; j < halfLen; j++) {
        const uRe = data[(i + j) * 2], uIm = data[(i + j) * 2 + 1];
        const vRe = data[(i + j + halfLen) * 2] * wRe - data[(i + j + halfLen) * 2 + 1] * wIm;
        const vIm = data[(i + j + halfLen) * 2] * wIm + data[(i + j + halfLen) * 2 + 1] * wRe;
        data[(i + j) * 2] = uRe + vRe; data[(i + j) * 2 + 1] = uIm + vIm;
        data[(i + j + halfLen) * 2] = uRe - vRe; data[(i + j + halfLen) * 2 + 1] = uIm - vIm;
        const newWRe = wRe * wReal - wIm * wImag;
        wIm = wRe * wImag + wIm * wReal; wRe = newWRe;
      }
    }
  }
}

function extractFrame(pcm: Float32Array, start: number, filterbank: Float32Array, window: Float32Array, cmvnMeans: Float32Array, cmvnIstd: Float32Array, frameLength: number, fftSize: number, numBins: number, numFreqBins: number): Float32Array {
  const frame = new Float32Array(pcm.subarray(start, start + frameLength));
  let dcSum = 0;
  for (let i = 0; i < frameLength; i++) dcSum += frame[i];
  const dcMean = dcSum / frameLength;
  for (let i = 0; i < frameLength; i++) frame[i] -= dcMean;
  for (let i = frameLength - 1; i > 0; i--) frame[i] -= 0.97 * frame[i - 1];
  frame[0] -= 0.97 * frame[0];
  const complex = new Float64Array(fftSize * 2);
  for (let i = 0; i < frameLength; i++) complex[i * 2] = frame[i] * window[i];
  rfft(complex, fftSize);
  const power = new Float32Array(numFreqBins);
  for (let i = 0; i <= fftSize / 2; i++) {
    const re = complex[i * 2], im = complex[i * 2 + 1];
    power[i] = re * re + im * im;
  }
  const fbank = new Float32Array(numBins);
  for (let m = 0; m < numBins; m++) {
    let sum = 0;
    const base = m * numFreqBins;
    for (let i = 0; i < numFreqBins; i++) sum += filterbank[base + i] * power[i];
    fbank[m] = sum;
  }
  for (let m = 0; m < numBins; m++) fbank[m] = Math.log(Math.max(fbank[m], 1.192e-7));
  for (let m = 0; m < numBins; m++) fbank[m] = (fbank[m] - cmvnMeans[m]) * cmvnIstd[m];
  return fbank;
}

async function main() {
  const raw = await readFile(PCM_PATH);
  const pcm16 = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  const pcm = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) pcm[i] = pcm16[i] / 32768;

  console.log('PCM length:', pcm.length);
  console.log('PCM range:', Math.min(...pcm), Math.max(...pcm));

  const cmvnData = await parseCmvn(CMVN_PATH);
  console.log('CMVN means range:', Math.min(...cmvnData.means), Math.max(...cmvnData.means));
  console.log('CMVN istd range:', Math.min(...cmvnData.inverseStdVariances), Math.max(...cmvnData.inverseStdVariances));

  const sampleRate = 16000, frameLength = 400, frameShift = 160, fftSize = 512, numBins = 80, numFreqBins = fftSize / 2 + 1;
  const filterbank = createFilterbank(sampleRate, numBins, fftSize);
  const window = createPoveyWindow(frameLength);

  const feat = extractFrame(pcm, 0, filterbank, window, cmvnData.means, cmvnData.inverseStdVariances, frameLength, fftSize, numBins, numFreqBins);
  console.log('Feature 0 range:', Math.min(...feat), Math.max(...feat));
  console.log('Feature 0 NaN:', feat.filter(x => isNaN(x)).length);
  console.log('Feature 0 first 10:', Array.from(feat.slice(0, 10)).map(v => v.toFixed(4)).join(', '));

  const session = await ort.InferenceSession.create(path.join(process.cwd(), 'models/firered-vad/fireredvad_stream_vad_with_cache.onnx'));
  const cache = new Float32Array(8 * 1 * 128 * 19);
  const result = await session.run({
    feat: new ort.Tensor('float32', feat, [1, 1, numBins]),
    caches_in: new ort.Tensor('float32', cache, [8, 1, 128, 19]),
  });
  console.log('Prob:', result.probs.data[0]);
  console.log('Cache NaN:', (result.caches_out.data as Float32Array).filter(x => isNaN(x)).length);

  await session.release();
}

main().catch((err) => { console.error(err); process.exit(1); });
