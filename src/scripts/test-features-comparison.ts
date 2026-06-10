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
  const raw = await readFile('/tmp/joe.pcm');
  const pcm16 = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  const pcm = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) pcm[i] = pcm16[i] / 32768;

  const cmvnData = await parseCmvn(path.join(process.cwd(), 'models/firered-vad/cmvn.ark'));
  const sampleRate = 16000, frameLength = 400, frameShift = 160, fftSize = 512, numBins = 80, numFreqBins = fftSize / 2 + 1;
  const filterbank = createFilterbank(sampleRate, numBins, fftSize);
  const window = createPoveyWindow(frameLength);

  const session = await ort.InferenceSession.create(path.join(process.cwd(), 'models/firered-vad/fireredvad_stream_vad_with_cache.onnx'));

  // Extract features for frames 0, 100, 104, 150
  for (const frameIdx of [0, 100, 104, 150]) {
    const start = frameIdx * frameShift;
    const feat = extractFrame(pcm, start, filterbank, window, cmvnData.means, cmvnData.inverseStdVariances, frameLength, fftSize, numBins, numFreqBins);
    const cache = new Float32Array(8 * 1 * 128 * 19).fill(0);
    const result = await session.run({
      feat: new ort.Tensor('float32', feat, [1, 1, numBins]),
      caches_in: new ort.Tensor('float32', cache, [8, 1, 128, 19]),
    });
    const prob = (result.probs.data as Float32Array)[0];
    console.log(`Frame ${frameIdx}: feat min=${Math.min(...feat).toFixed(2)} max=${Math.max(...feat).toFixed(2)}, prob=${prob.toFixed(4)}`);
  }

  // Compare with Slaney features (old implementation)
  function melScaleSlaney(freq: number): number {
    if (freq <= 1000) return (freq * 3) / 200;
    return 15 + 14.545078505785561 * Math.log(freq / 1000);
  }
  function invMelScaleSlaney(mel: number): number {
    if (mel <= 15) return (200 / 3) * mel;
    return 1000 * Math.exp((mel - 15) * 0.06875177742094911);
  }

  const fbSlaney = new Float32Array(numBins * numFreqBins);
  const fftBinWidth = sampleRate / fftSize;
  const melLowS = melScaleSlaney(20);
  const melHighS = melScaleSlaney(sampleRate / 2);
  const melDeltaS = (melHighS - melLowS) / (numBins + 1);
  for (let bin = 0; bin < numBins; bin++) {
    const leftMel = melLowS + bin * melDeltaS;
    const centerMel = melLowS + (bin + 1) * melDeltaS;
    const rightMel = melLowS + (bin + 2) * melDeltaS;
    const leftHz = invMelScaleSlaney(leftMel);
    const centerHz = invMelScaleSlaney(centerMel);
    const rightHz = invMelScaleSlaney(rightMel);
    for (let i = 0; i < numFreqBins; i++) {
      const hz = fftBinWidth * i;
      if (hz > leftHz && hz < rightHz) {
        let weight: number;
        if (hz <= centerHz) weight = (hz - leftHz) / (centerHz - leftHz);
        else weight = (rightHz - hz) / (rightHz - centerHz);
        weight *= 2.0 / (rightHz - leftHz);
        fbSlaney[bin * numFreqBins + i] = weight;
      }
    }
  }

  console.log('\n--- Slaney (old) ---');
  for (const frameIdx of [0, 100, 104, 150]) {
    const start = frameIdx * frameShift;
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
      for (let i = 0; i < numFreqBins; i++) sum += fbSlaney[base + i] * power[i];
      fbank[m] = sum;
    }
    for (let m = 0; m < numBins; m++) fbank[m] = Math.log(Math.max(fbank[m], 1.192e-7));
    for (let m = 0; m < numBins; m++) fbank[m] = (fbank[m] - cmvnData.means[m]) * cmvnData.inverseStdVariances[m];
    const cache = new Float32Array(8 * 1 * 128 * 19).fill(0);
    const result = await session.run({
      feat: new ort.Tensor('float32', fbank, [1, 1, numBins]),
      caches_in: new ort.Tensor('float32', cache, [8, 1, 128, 19]),
    });
    const prob = (result.probs.data as Float32Array)[0];
    console.log(`Frame ${frameIdx}: feat min=${Math.min(...fbank).toFixed(2)} max=${Math.max(...fbank).toFixed(2)}, prob=${prob.toFixed(4)}`);
  }

  await session.release();
}

main().catch((err) => { console.error(err); process.exit(1); });
