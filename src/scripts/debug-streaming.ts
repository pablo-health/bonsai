import { readFile } from 'fs/promises';
import * as path from 'path';

// Inline fbank extraction to match Kaldi
function melScaleSlaney(freq: number): number {
  if (freq <= 1000) return (freq * 3) / 200;
  return 15 + 14.545078505785561 * Math.log(freq / 1000);
}

function invMelScaleSlaney(mel: number): number {
  if (mel <= 15) return (200 / 3) * mel;
  return 1000 * Math.exp((mel - 15) * 0.06875177742094911);
}

function createFilterbank(sampleRate: number, numBins: number, fftSize: number) {
  const numFreqBins = fftSize / 2 + 1;
  const fftBinWidth = sampleRate / fftSize;
  const lowFreq = 20;
  const highFreq = sampleRate / 2;
  const melLow = melScaleSlaney(lowFreq);
  const melHigh = melScaleSlaney(highFreq);
  const melDelta = (melHigh - melLow) / (numBins + 1);
  const fb = new Float32Array(numBins * numFreqBins);
  for (let bin = 0; bin < numBins; bin++) {
    const leftMel = melLow + bin * melDelta;
    const centerMel = melLow + (bin + 1) * melDelta;
    const rightMel = melLow + (bin + 2) * melDelta;
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
        fb[bin * numFreqBins + i] = weight;
      }
    }
  }
  return fb;
}

function createPoveyWindow(size: number): Float32Array {
  const window = new Float32Array(size);
  const a = 2 * Math.PI / (size - 1);
  for (let i = 0; i < size; i++) {
    window[i] = Math.pow(0.5 - 0.5 * Math.cos(a * i), 0.85);
  }
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

function parseCmvn(buffer: Buffer) {
  let offset = buffer.indexOf(0x20) + 1;
  offset += 1;
  const rows = buffer.readInt32LE(offset); offset += 4;
  offset += 1;
  const cols = buffer.readInt32LE(offset); offset += 4;
  const dim = cols - 1;
  const matrix = new Float64Array(rows * cols);
  for (let i = 0; i < rows * cols; i++) {
    matrix[i] = buffer.readDoubleLE(offset); offset += 8;
  }
  const count = matrix[dim];
  const means = new Float32Array(dim);
  const istd = new Float32Array(dim);
  for (let d = 0; d < dim; d++) {
    const mean = matrix[d] / count;
    const sos = matrix[dim + 1 + d];
    const variance = sos / count - mean * mean;
    const v = variance < 1e-20 ? 1e-20 : variance;
    const std = Math.max(Math.sqrt(v), 0.01);
    means[d] = mean;
    istd[d] = 1.0 / std;
  }
  return { means, istd };
}

async function main() {
  const { execSync } = await import('child_process');
  const { mkdtempSync, unlinkSync } = await import('fs');
  const { tmpdir } = await import('os');

  const tmpDir = mkdtempSync(path.join(tmpdir(), 'debug-'));
  const pcmPath = path.join(tmpDir, 'audio.pcm');
  execSync('ffmpeg -y -i "/home/patryk/Downloads/user_voice_2026-05-25-16-29-58.opus" -f s16le -ar 16000 -ac 1 "' + pcmPath + '"', { stdio: 'pipe' });

  const raw = await readFile(pcmPath);
  const pcm16 = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  const pcm = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) pcm[i] = pcm16[i];

  unlinkSync(pcmPath);

  const cmvnData = parseCmvn(await readFile(path.join(process.cwd(), 'models/firered-vad/cmvn.ark')));
  const sr = 16000;
  const frameLength = 400;
  const frameShift = 160;
  const fftSize = 512;
  const numBins = 80;
  const numFreqBins = fftSize / 2 + 1;
  const filterbank = createFilterbank(sr, numBins, fftSize);
  const window = createPoveyWindow(frameLength);

  // Batch extraction (Kaldi-style)
  const numFrames = Math.floor((pcm.length - frameLength) / frameShift) + 1;
  const batchFrame100 = extractFrameBatch(pcm, 100, frameLength, frameShift, fftSize, numBins, numFreqBins, filterbank, window, cmvnData);

  // Streaming extraction (wrapper-style)
  const streamingFrames: Float32Array[] = [];
  const ringBuffer = new Float32Array(frameLength - frameShift);
  let ringPos = 0, ringFilled = 0;

  for (let f = 0; f < numFrames; f++) {
    const start = f * frameShift;
    const newSamples = pcm.subarray(start, start + frameShift);

    const overlapLen = frameLength - frameShift;
    const frame = new Float32Array(frameLength);

    if (ringPos + overlapLen <= ringFilled) {
      frame.set(ringBuffer.subarray(ringPos, ringPos + overlapLen), 0);
    } else {
      const firstPart = ringFilled - ringPos;
      frame.set(ringBuffer.subarray(ringPos, ringFilled), 0);
      frame.set(ringBuffer.subarray(0, overlapLen - firstPart), firstPart);
    }
    frame.set(newSamples, overlapLen);

    const storePos = (ringPos + overlapLen) % (frameLength - frameShift);
    if (storePos + frameShift <= frameLength - frameShift) {
      ringBuffer.set(newSamples, storePos);
    } else {
      const firstPart = frameLength - frameShift - storePos;
      ringBuffer.set(newSamples.subarray(0, firstPart), storePos);
      ringBuffer.set(newSamples.subarray(firstPart), 0);
    }
    ringPos = (ringPos + frameShift) % (frameLength - frameShift);
    ringFilled = Math.min(ringFilled + frameShift, frameLength - frameShift);

    let dcSum = 0;
    for (let i = 0; i < frameLength; i++) dcSum += frame[i];
    const dcMean = dcSum / frameLength;
    for (let i = 0; i < frameLength; i++) frame[i] -= dcMean;

    for (let i = frameLength - 1; i > 0; i--) frame[i] -= 0.97 * frame[i - 1];
    frame[0] -= 0.97 * frame[0];

    for (let i = 0; i < frameLength; i++) frame[i] *= window[i];

    const complex = new Float64Array(fftSize * 2);
    for (let i = 0; i < frameLength; i++) complex[i * 2] = frame[i];
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

    for (let m = 0; m < numBins; m++) fbank[m] = Math.log(fbank[m] + 1e-10);
    for (let m = 0; m < numBins; m++) fbank[m] = (fbank[m] - cmvnData.means[m]) * cmvnData.istd[m];

    if (f === 100) streamingFrames.push(fbank);
  }

  console.log('Batch frame 100: min=' + Math.min(...batchFrame100).toFixed(4) + ' max=' + Math.max(...batchFrame100).toFixed(4));
  console.log('Streaming frame 100: min=' + Math.min(...streamingFrames[0]).toFixed(4) + ' max=' + Math.max(...streamingFrames[0]).toFixed(4));

  let maxDiff = 0;
  for (let i = 0; i < numBins; i++) {
    const diff = Math.abs(batchFrame100[i] - streamingFrames[0][i]);
    if (diff > maxDiff) maxDiff = diff;
  }
  console.log('Max diff: ' + maxDiff.toFixed(6));
}

function extractFrameBatch(pcm: Float32Array, frameIdx: number, frameLength: number, frameShift: number, fftSize: number, numBins: number, numFreqBins: number, filterbank: Float32Array, window: Float32Array, cmvnData: { means: Float32Array; istd: Float32Array }): Float32Array {
  const start = frameIdx * frameShift;
  const frame = new Float32Array(pcm.subarray(start, start + frameLength));

  let dcSum = 0;
  for (let i = 0; i < frameLength; i++) dcSum += frame[i];
  const dcMean = dcSum / frameLength;
  for (let i = 0; i < frameLength; i++) frame[i] -= dcMean;

  for (let i = frameLength - 1; i > 0; i--) frame[i] -= 0.97 * frame[i - 1];
  frame[0] -= 0.97 * frame[0];

  for (let i = 0; i < frameLength; i++) frame[i] *= window[i];

  const complex = new Float64Array(fftSize * 2);
  for (let i = 0; i < frameLength; i++) complex[i * 2] = frame[i];
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

  for (let m = 0; m < numBins; m++) fbank[m] = Math.log(fbank[m] + 1e-10);
  for (let m = 0; m < numBins; m++) fbank[m] = (fbank[m] - cmvnData.means[m]) * cmvnData.istd[m];
  return fbank;
}

main().catch(console.error);
