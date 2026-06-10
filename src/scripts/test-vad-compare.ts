import { readFileSync } from 'fs';
import { resolveCmvnPath } from '../services/audio/FireRedVadWrapper';

const refData = readFileSync('/tmp/reference_log_features.raw');
const ref = new Float32Array(refData.buffer);

const pcmData = readFileSync('/tmp/libri_test.pcm');
const pcm = new Float32Array(pcmData.length / 2);
for (let i = 0; i < pcm.length; i++) {
  pcm[i] = pcmData.readInt16LE(i * 2);
}

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

// Inline all-at-once extraction (verified correct)
const FBANK_FRAME_LENGTH = 400;
const FBANK_FRAME_SHIFT = 160;
const FBANK_NUM_MEL_BINS = 80;
const FFT_SIZE = 512;
const NUM_FREQ_BINS = FFT_SIZE / 2 + 1;
const SAMPLE_RATE = 16000;

const poveyWindow = new Float32Array(FBANK_FRAME_LENGTH);
const a = 2 * Math.PI / (FBANK_FRAME_LENGTH - 1);
for (let i = 0; i < FBANK_FRAME_LENGTH; i++) {
  poveyWindow[i] = Math.pow(0.5 - 0.5 * Math.cos(a * i), 0.85);
}

function melScaleHtk(freq: number): number {
  return 1127.0 * Math.log(1.0 + freq / 700.0);
}

const melFilterbank = new Float32Array(FBANK_NUM_MEL_BINS * NUM_FREQ_BINS);
const fftBinWidth = SAMPLE_RATE / FFT_SIZE;
const melLow = melScaleHtk(20);
const melHigh = melScaleHtk(SAMPLE_RATE / 2);
const melDelta = (melHigh - melLow) / (FBANK_NUM_MEL_BINS + 1);

for (let bin = 0; bin < FBANK_NUM_MEL_BINS; bin++) {
  const leftMel = melLow + bin * melDelta;
  const centerMel = melLow + (bin + 1) * melDelta;
  const rightMel = melLow + (bin + 2) * melDelta;
  for (let i = 0; i < NUM_FREQ_BINS; i++) {
    const freq = fftBinWidth * i;
    const mel = melScaleHtk(freq);
    if (mel > leftMel && mel < rightMel) {
      let weight: number;
      if (mel <= centerMel) {
        weight = (mel - leftMel) / (centerMel - leftMel);
      } else {
        weight = (rightMel - mel) / (rightMel - centerMel);
      }
      melFilterbank[bin * NUM_FREQ_BINS + i] = weight;
    }
  }
}

const filterbankLayout: number[] = [];
for (let bin = 0; bin < FBANK_NUM_MEL_BINS; bin++) {
  let first = -1;
  let cnt = 0;
  for (let i = 0; i < NUM_FREQ_BINS; i++) {
    if (melFilterbank[bin * NUM_FREQ_BINS + i] !== 0) {
      if (first === -1) first = i;
      cnt++;
    }
  }
  filterbankLayout.push(first);
  filterbankLayout.push(cnt);
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

function extractFrame(frame: Float32Array): Float32Array {
  // DC removal
  let dcSum = 0;
  for (let i = 0; i < FBANK_FRAME_LENGTH; i++) dcSum += frame[i];
  const dcMean = dcSum / FBANK_FRAME_LENGTH;
  for (let i = 0; i < FBANK_FRAME_LENGTH; i++) frame[i] -= dcMean;

  // Pre-emphasis
  for (let i = FBANK_FRAME_LENGTH - 1; i > 0; i--) {
    frame[i] -= 0.97 * frame[i - 1];
  }

  // Window
  for (let i = 0; i < FBANK_FRAME_LENGTH; i++) {
    frame[i] *= poveyWindow[i];
  }

  // FFT
  const complex = new Float64Array(FFT_SIZE * 2);
  for (let i = 0; i < FBANK_FRAME_LENGTH; i++) {
    complex[i * 2] = frame[i];
  }
  rfft(complex, FFT_SIZE);

  const power = new Float32Array(FFT_SIZE / 2 + 1);
  for (let i = 0; i <= FFT_SIZE / 2; i++) {
    const re = complex[i * 2], im = complex[i * 2 + 1];
    power[i] = re * re + im * im;
  }

  // Filterbank
  const fbank = new Float32Array(FBANK_NUM_MEL_BINS);
  for (let m = 0; m < FBANK_NUM_MEL_BINS; m++) {
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

  // CMVN
  for (let m = 0; m < FBANK_NUM_MEL_BINS; m++) {
    fbank[m] = (fbank[m] - means[m]) * inverseStdVariances[m];
  }

  return fbank;
}

// All-at-once (reference)
const numFrames = Math.floor((pcm.length - FBANK_FRAME_LENGTH) / FBANK_FRAME_SHIFT + 1);
const allAtOnceFeatures = new Float32Array(numFrames * FBANK_NUM_MEL_BINS);

for (let f = 0; f < numFrames; f++) {
  const start = f * FBANK_FRAME_SHIFT;
  const frame = new Float32Array(pcm.subarray(start, start + FBANK_FRAME_LENGTH));
  const fbank = extractFrame(frame);
  allAtOnceFeatures.set(fbank, f * FBANK_NUM_MEL_BINS);
}

// Compare all-at-once vs reference (pre-CMVN)
// Note: reference is pre-CMVN, so we need to compare without CMVN
// Actually, let's compare all-at-once with CMVN vs reference with CMVN
const refCmvnData = readFileSync('/tmp/reference_features.raw');
const refCmvn = new Float32Array(refCmvnData.buffer);

let maxDiff = 0;
let maxIdx = 0;
let sumDiff = 0;

for (let i = 0; i < refCmvn.length; i++) {
  const d = Math.abs(allAtOnceFeatures[i] - refCmvn[i]);
  sumDiff += d;
  if (d > maxDiff) { maxDiff = d; maxIdx = i; }
}

const meanDiff = sumDiff / refCmvn.length;
const maxFrame = Math.floor(maxIdx / FBANK_NUM_MEL_BINS);
const maxBin = maxIdx % FBANK_NUM_MEL_BINS;

console.log('All-at-once frames:', numFrames);
console.log('Reference frames:', refCmvn.length / FBANK_NUM_MEL_BINS);
console.log(`Max diff: ${maxDiff} at frame ${maxFrame} bin ${maxBin}`);
console.log(`Mean diff: ${meanDiff}`);
console.log(`Match (atol 1e-2): ${maxDiff < 1e-2}`);
console.log(`Match (atol 0.1): ${maxDiff < 0.1}`);
