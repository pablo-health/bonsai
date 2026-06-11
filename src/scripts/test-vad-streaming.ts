import { readFileSync } from 'fs';
import { resolveCmvnPath, FbankExtractor, pcm16ToFloat32 } from '../services/audio/FireRedVadWrapper';

const PCM_FRAME_SHIFT = 160;
const PCM_FRAME_LENGTH = 400;

const pcmData = readFileSync('/tmp/libri_test.pcm');
const pcmFloat = pcm16ToFloat32(pcmData);

const cmvnBuffer = readFileSync(resolveCmvnPath());
let off = 0;
const keyEnd = cmvnBuffer.indexOf(0x20, off);
off = keyEnd + 1;
off += 1;
const rows = cmvnBuffer.readInt32LE(off);
off += 4;
off += 1;
const cols = cmvnBuffer.readInt32LE(off);
off += 4;
const dim = cols - 1;
const matrix = new Float64Array(rows * cols);
for (let i = 0; i < rows * cols; i++) {
  matrix[i] = cmvnBuffer.readDoubleLE(off);
  off += 8;
}
const cnt = matrix[dim];
const means = new Float32Array(dim);
const inverseStdVariances = new Float32Array(dim);
for (let d = 0; d < dim; d++) {
  const mean = matrix[d] / cnt;
  const sos = matrix[dim + 1 + d];
  const variance = sos / cnt - mean * mean;
  const v = variance < 1e-20 ? 1e-20 : variance;
  means[d] = mean;
  inverseStdVariances[d] = 1.0 / Math.sqrt(v);
}

// Batch: extract all frames independently
const numFrames = Math.floor((pcmFloat.length - PCM_FRAME_LENGTH) / PCM_FRAME_SHIFT) + 1;
const batchFeatures: Float32Array[] = [];
for (let f = 0; f < numFrames; f++) {
  const start = f * PCM_FRAME_SHIFT;
  const frame = new Float32Array(pcmFloat.subarray(start, start + PCM_FRAME_LENGTH));
  batchFeatures.push(processFrame(frame, means, inverseStdVariances));
}

// Streaming: feed 160 samples at a time, skip warmup zeros
const streamingFeatures: Float32Array[] = [];
const fbank = new FbankExtractor(16000, { means, inverseStdVariances });
for (let i = 0; i < pcmFloat.length; i += PCM_FRAME_SHIFT) {
  const chunk = new Float32Array(pcmFloat.subarray(i, i + PCM_FRAME_SHIFT));
  if (chunk.length < PCM_FRAME_SHIFT) break;
  const feat = fbank.extractFrame(chunk);
  // Skip zero-feature warmup frames
  if (feat[0] !== 0 || feat.reduce((a, b) => a + Math.abs(b), 0) > 0.001) {
    streamingFeatures.push(feat);
  }
}

console.log('Batch frames:', batchFeatures.length);
console.log('Streaming frames (non-zero):', streamingFeatures.length);

// Compare aligned
let maxDiff = 0;
let maxFrame = 0;
let maxBin = 0;
const compareLen = Math.min(batchFeatures.length, streamingFeatures.length);

for (let f = 0; f < compareLen; f++) {
  for (let b = 0; b < 80; b++) {
    const d = Math.abs(batchFeatures[f][b] - streamingFeatures[f][b]);
    if (d > maxDiff) {
      maxDiff = d;
      maxFrame = f;
      maxBin = b;
    }
  }
}

console.log(`Frames compared: ${compareLen}`);
console.log(`Max diff: ${maxDiff.toFixed(8)} at frame ${maxFrame} bin ${maxBin}`);
console.log(`Match (atol 1e-2): ${maxDiff < 1e-2}`);
console.log(`Match (atol 1e-4): ${maxDiff < 1e-4}`);
console.log(`Match (atol 1e-6): ${maxDiff < 1e-6}`);

for (let f = 0; f < Math.min(5, compareLen); f++) {
  let sumDiff = 0;
  for (let b = 0; b < 80; b++) {
    sumDiff += Math.abs(batchFeatures[f][b] - streamingFeatures[f][b]);
  }
  console.log(`Frame ${f}: batch [${batchFeatures[f][0].toFixed(4)}, ${Math.max(...batchFeatures[f]).toFixed(4)}] stream [${streamingFeatures[f][0].toFixed(4)}, ${Math.max(...streamingFeatures[f]).toFixed(4)}] sumDiff=${sumDiff.toFixed(6)}`);
}

function processFrame(frame: Float32Array, cmvnMeans: Float32Array, cmvnIstd: Float32Array): Float32Array {
  const FRAME_LENGTH = 400;
  const FFT_SIZE = 512;
  const NUM_BINS = 80;
  const NUM_FREQ_BINS = FFT_SIZE / 2 + 1;
  const SAMPLE_RATE = 16000;

  let dcSum = 0;
  for (let i = 0; i < FRAME_LENGTH; i++) dcSum += frame[i];
  const dcMean = dcSum / FRAME_LENGTH;
  for (let i = 0; i < FRAME_LENGTH; i++) frame[i] -= dcMean;

  for (let i = FRAME_LENGTH - 1; i > 0; i--) {
    frame[i] -= 0.97 * frame[i - 1];
  }

  const poveyWindow = new Float32Array(FRAME_LENGTH);
  const a = 2 * Math.PI / (FRAME_LENGTH - 1);
  for (let i = 0; i < FRAME_LENGTH; i++) {
    poveyWindow[i] = Math.pow(0.5 - 0.5 * Math.cos(a * i), 0.85);
  }
  for (let i = 0; i < FRAME_LENGTH; i++) {
    frame[i] *= poveyWindow[i];
  }

  const complex = new Float64Array(FFT_SIZE * 2);
  for (let i = 0; i < FRAME_LENGTH; i++) {
    complex[i * 2] = frame[i];
  }
  rfft(complex, FFT_SIZE);

  const power = new Float32Array(NUM_FREQ_BINS);
  for (let i = 0; i <= FFT_SIZE / 2; i++) {
    const re = complex[i * 2], im = complex[i * 2 + 1];
    power[i] = re * re + im * im;
  }

  const melFilterbank = createMelFilterbank(SAMPLE_RATE, NUM_BINS, FFT_SIZE);
  const filterbankLayout = createFilterbankLayout(melFilterbank, NUM_BINS, NUM_FREQ_BINS);

  const fbank = new Float32Array(NUM_BINS);
  for (let m = 0; m < NUM_BINS; m++) {
    let sum = 0;
    const base = m * NUM_FREQ_BINS;
    const first = filterbankLayout[m * 2];
    const count = filterbankLayout[m * 2 + 1];
    for (let i = 0; i < count; i++) {
      const idx = first + i;
      sum += melFilterbank[base + idx] * power[idx];
    }
    fbank[m] = Math.log(sum < 1.192e-7 ? 1.192e-7 : sum);
  }

  for (let m = 0; m < NUM_BINS; m++) {
    fbank[m] = (fbank[m] - cmvnMeans[m]) * cmvnIstd[m];
  }

  return fbank;
}

function melScaleHtk(freq: number): number {
  return 1127.0 * Math.log(1.0 + freq / 700.0);
}

function createMelFilterbank(sampleRate: number, numBins: number, fftSize: number): Float32Array {
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
    for (let i = 0; i < numFreqBins; i++) {
      const mel = melScaleHtk(fftBinWidth * i);
      if (mel > leftMel && mel < rightMel) {
        let weight: number;
        if (mel <= centerMel) {
          weight = (mel - leftMel) / (centerMel - leftMel);
        } else {
          weight = (rightMel - mel) / (rightMel - centerMel);
        }
        fb[bin * numFreqBins + i] = weight;
      }
    }
  }
  return fb;
}

function createFilterbankLayout(filterbank: Float32Array, numBins: number, numFreqBins: number): number[] {
  const layout: number[] = [];
  for (let bin = 0; bin < numBins; bin++) {
    let first = -1, count = 0;
    for (let i = 0; i < numFreqBins; i++) {
      if (filterbank[bin * numFreqBins + i] !== 0) {
        if (first === -1) first = i;
        count++;
      }
    }
    layout.push(first, count);
  }
  return layout;
}

function rfft(data: Float64Array, n: number): void {
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let j = 0;
    for (let b = 0; b < bits; b++) {
      j = (j << 1) | ((i >> b) & 1);
    }
    if (i < j) {
      const tmp = data[i * 2]; data[i * 2] = data[j * 2]; data[j * 2] = tmp;
      const tmpIm = data[i * 2 + 1]; data[i * 2 + 1] = data[j * 2 + 1]; data[j * 2 + 1] = tmpIm;
    }
  }
  for (let len = 2; len <= n; len *= 2) {
    const halfLen = len / 2;
    const wReal = Math.cos(-2 * Math.PI / len);
    const wImag = Math.sin(-2 * Math.PI / len);
    for (let i = 0; i < n; i += len) {
      let wRe = 1, wIm = 0;
      for (let j = 0; j < halfLen; j++) {
        const uRe = data[(i + j) * 2], uIm = data[(i + j) * 2 + 1];
        const vRe = data[(i + j + halfLen) * 2] * wRe - data[(i + j + halfLen) * 2 + 1] * wIm;
        const vIm = data[(i + j + halfLen) * 2] * wIm + data[(i + j + halfLen) * 2 + 1] * wRe;
        data[(i + j) * 2] = uRe + vRe; data[(i + j) * 2 + 1] = uIm + vIm;
        data[(i + j + halfLen) * 2] = uRe - vRe; data[(i + j + halfLen) * 2 + 1] = uIm - vIm;
        const newWRe = wRe * wReal - wIm * wImag;
        wIm = wRe * wImag + wIm * wReal;
        wRe = newWRe;
      }
    }
  }
}
