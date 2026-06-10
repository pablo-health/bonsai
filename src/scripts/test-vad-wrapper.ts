import { readFile } from 'fs/promises';
import * as path from 'path';

// Direct test of FbankExtractor
const MODULE_DIR = path.join(process.cwd(), 'src/services/audio');

// We can't easily import the class due to module resolution. Let's test inline.

// Parse CMVN
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
    const std = Math.max(Math.sqrt(v), 0.01);
    means[d] = mean;
    inverseStdVariances[d] = 1.0 / std;
  }
  return { means, inverseStdVariances };
}

// Slaney mel scale
function melScaleSlaney(freq: number): number {
  if (freq <= 1000) {
    return (freq * 3) / 200;
  }
  return 15 + 14.545078505785561 * Math.log(freq / 1000);
}

function invMelScaleSlaney(mel: number): number {
  if (mel <= 15) {
    return (200 / 3) * mel;
  }
  return 1000 * Math.exp((mel - 15) * 0.06875177742094911);
}

// Build filterbank
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
        if (hz <= centerHz) {
          weight = (hz - leftHz) / (centerHz - leftHz);
        } else {
          weight = (rightHz - hz) / (rightHz - centerHz);
        }
        weight *= 2.0 / (rightHz - leftHz);
        fb[bin * numFreqBins + i] = weight;
      }
    }
  }
  return fb;
}

// Povey window: pow(0.5 - 0.5 * cos(2*pi*i/(N-1)), 0.85)
function createPoveyWindow(size: number): Float32Array {
  const window = new Float32Array(size);
  const a = 2 * Math.PI / (size - 1);
  for (let i = 0; i < size; i++) {
    window[i] = Math.pow(0.5 - 0.5 * Math.cos(a * i), 0.85);
  }
  return window;
}

// Custom FFT
function rfft(data: Float64Array, n: number): void {
  const bits = Math.log2(n);

  for (let i = 0; i < n; i++) {
    let j = 0;
    for (let b = 0; b < bits; b++) {
      j = (j << 1) | ((i >> b) & 1);
    }
    if (i < j) {
      const tmp = data[i * 2];
      data[i * 2] = data[j * 2];
      data[j * 2] = tmp;
      const tmpIm = data[i * 2 + 1];
      data[i * 2 + 1] = data[j * 2 + 1];
      data[j * 2 + 1] = tmpIm;
    }
  }

  for (let len = 2; len <= n; len *= 2) {
    const halfLen = len / 2;
    const angleStep = -2 * Math.PI / len;
    const wReal = Math.cos(angleStep);
    const wImag = Math.sin(angleStep);

    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let j = 0; j < halfLen; j++) {
        const uRe = data[(i + j) * 2];
        const uIm = data[(i + j) * 2 + 1];
        const vRe = data[(i + j + halfLen) * 2] * wRe - data[(i + j + halfLen) * 2 + 1] * wIm;
        const vIm = data[(i + j + halfLen) * 2] * wIm + data[(i + j + halfLen) * 2 + 1] * wRe;

        data[(i + j) * 2] = uRe + vRe;
        data[(i + j) * 2 + 1] = uIm + vIm;
        data[(i + j + halfLen) * 2] = uRe - vRe;
        data[(i + j + halfLen) * 2 + 1] = uIm - vIm;

        const newWRe = wRe * wReal - wIm * wImag;
        wIm = wRe * wImag + wIm * wReal;
        wRe = newWRe;
      }
    }
  }
}

// Extract features (direct framing, Kaldi-compatible)
function extractFeaturesAll(
  pcm: Float32Array,
  filterbank: Float32Array,
  window: Float32Array,
  cmvnMeans: Float32Array,
  cmvnIstd: Float32Array,
  sampleRate: number,
  frameLength: number,
  frameShift: number,
  fftSize: number,
  numBins: number,
  numFreqBins: number,
) {
  const numFrames = Math.floor((pcm.length - frameLength) / frameShift) + 1;
  const frames: Float32Array[] = [];

  for (let f = 0; f < numFrames; f++) {
    const start = f * frameShift;
    const frame = new Float32Array(pcm.subarray(start, start + frameLength));

    // Kaldi ProcessWindow order: DC removal → pre-emphasis → window
    // DC removal
    let dcSum = 0;
    for (let i = 0; i < frameLength; i++) {
      dcSum += frame[i];
    }
    const dcMean = dcSum / frameLength;
    for (let i = 0; i < frameLength; i++) {
      frame[i] -= dcMean;
    }

    // Pre-emphasis (per-frame, Kaldi backward order, d[0] -= coeff * d[0])
    for (let i = frameLength - 1; i > 0; i--) {
      frame[i] -= 0.97 * frame[i - 1];
    }
    frame[0] -= 0.97 * frame[0];

    // Window
    const windowed = new Float64Array(fftSize);
    for (let i = 0; i < frameLength; i++) {
      windowed[i] = frame[i] * window[i];
    }

    // FFT
    const complex = new Float64Array(fftSize * 2);
    for (let i = 0; i < fftSize; i++) {
      complex[i * 2] = windowed[i];
    }
    rfft(complex, fftSize);

    // Power spectrum
    const power = new Float32Array(numFreqBins);
    for (let i = 0; i <= fftSize / 2; i++) {
      const re = complex[i * 2];
      const im = complex[i * 2 + 1];
      power[i] = re * re + im * im;
    }

    // Mel filterbank
    const fbank = new Float32Array(numBins);
    for (let m = 0; m < numBins; m++) {
      let sum = 0;
      const base = m * numFreqBins;
      for (let i = 0; i < numFreqBins; i++) {
        sum += filterbank[base + i] * power[i];
      }
      fbank[m] = sum;
    }

    // Log
    for (let m = 0; m < numBins; m++) {
      fbank[m] = Math.log(fbank[m] + 1e-10);
    }

    // CMVN
    for (let m = 0; m < numBins; m++) {
      fbank[m] = (fbank[m] - cmvnMeans[m]) * cmvnIstd[m];
    }

    frames.push(fbank);
  }

  return frames;
}

// Run ONNX model
async function runModel(
  modelPath: string,
  features: Float32Array[],
  numBins: number,
) {
  const ort = await import('onnxruntime-node');
  const session = await ort.InferenceSession.create(modelPath);

  const cache = new Float32Array(8 * 1 * 128 * 19);
  const probs: number[] = [];

  for (let i = 0; i < features.length; i++) {
    const feat = features[i];
    const inputs = {
      feat: new ort.Tensor('float32', feat, [1, 1, numBins]),
      caches_in: new ort.Tensor('float32', cache, [8, 1, 128, 19]),
    };

    const result = await session.run(inputs);
    const prob = (result.probs.data as Float32Array)[0];
    probs.push(prob);
    const newCache = result.caches_out.data as Float32Array;
    cache.set(newCache);
  }

  return probs;
}

// State machine
enum VadState {
  SILENCE = 0,
  POSSIBLE_SPEECH = 1,
  SPEECH = 2,
  POSSIBLE_SILENCE = 3,
}

class SM {
  smoothWindow: number[] = [];
  smoothWindowSum = 0;
  state = VadState.SILENCE;
  speechCnt = 0;
  silenceCnt = 0;
  hitMaxSpeech = false;
  frameCnt = 0;

  process(prob: number) {
    this.frameCnt++;
    this.smoothWindow.push(prob);
    this.smoothWindowSum += prob;
    if (this.smoothWindow.length > 5) {
      this.smoothWindowSum -= this.smoothWindow.shift()!;
    }
    const smoothed = this.smoothWindowSum / this.smoothWindow.length;
    const isSpeech = smoothed >= 0.5 ? 1 : 0;

    if (this.hitMaxSpeech) {
      this.hitMaxSpeech = false;
    }

    if (this.state === VadState.SILENCE) {
      if (isSpeech) {
        this.state = VadState.POSSIBLE_SPEECH;
        this.speechCnt++;
      } else {
        this.silenceCnt++;
        this.speechCnt = 0;
      }
    } else if (this.state === VadState.POSSIBLE_SPEECH) {
      if (isSpeech) {
        this.speechCnt++;
        if (this.speechCnt >= 8) {
          this.state = VadState.SPEECH;
          this.silenceCnt = 0;
        }
      } else {
        this.state = VadState.SILENCE;
        this.silenceCnt = 1;
        this.speechCnt = 0;
      }
    } else if (this.state === VadState.SPEECH) {
      this.speechCnt++;
      if (isSpeech) {
        this.silenceCnt = 0;
        if (this.speechCnt >= 2000) {
          this.hitMaxSpeech = true;
          this.speechCnt = 0;
        }
      } else {
        this.state = VadState.POSSIBLE_SILENCE;
        this.silenceCnt++;
      }
    } else if (this.state === VadState.POSSIBLE_SILENCE) {
      this.speechCnt++;
      if (isSpeech) {
        this.state = VadState.SPEECH;
        this.silenceCnt = 0;
      } else {
        this.silenceCnt++;
        if (this.silenceCnt >= 20) {
          this.state = VadState.SILENCE;
          this.speechCnt = 0;
        }
      }
    }
  }

  getSegments(probs: number[]) {
    const segs: Array<[number, number]> = [];
    let inSpeech = false;
    let start = -1;

    for (let i = 0; i < probs.length; i++) {
      this.process(probs[i]);
      if (this.state === VadState.SPEECH && !inSpeech) {
        inSpeech = true;
        start = i;
      } else if (this.state === VadState.SILENCE && inSpeech) {
        inSpeech = false;
        segs.push([start, i]);
      }
    }
    if (inSpeech) {
      segs.push([start, probs.length]);
    }
    return segs;
  }
}

async function main() {
  const raw = await readFile('/tmp/joe.pcm');
  const pcm16 = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  const pcm = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    pcm[i] = pcm16[i];
  }

  const cmvnPath = path.join(process.cwd(), 'models/firered-vad/cmvn.ark');
  const cmvnData = await parseCmvn(cmvnPath);

  const sampleRate = 16000;
  const frameLength = 400;
  const frameShift = 160;
  const fftSize = 512;
  const numBins = 80;
  const numFreqBins = fftSize / 2 + 1;

  const filterbank = createFilterbank(sampleRate, numBins, fftSize);
  const window = createPoveyWindow(frameLength);

  const frames = extractFeaturesAll(
    pcm, filterbank, window, cmvnData.means, cmvnData.inverseStdVariances,
    sampleRate, frameLength, frameShift, fftSize, numBins, numFreqBins,
  );

  console.log(`Frames: ${frames.length}`);
  console.log(`Frame 0: [${Math.min(...frames[0]).toFixed(2)}, ${Math.max(...frames[0]).toFixed(2)}]`);
  console.log(`Frame 100: [${Math.min(...frames[100]).toFixed(2)}, ${Math.max(...frames[100]).toFixed(2)}]`);

  const modelPath = path.join(process.cwd(), 'models/firered-vad/fireredvad_stream_vad_with_cache.onnx');
  const probs = await runModel(modelPath, frames, numBins);

  console.log(`Probs: min=${Math.min(...probs).toFixed(4)}, max=${Math.max(...probs).toFixed(4)}`);

  const sm = new SM();
  const segs = sm.getSegments(probs);
  console.log(`TS Segments: ${JSON.stringify(segs)}`);
  console.log(`Expected: [[104, 249]]`);

  // UH
  const raw2 = await readFile('/tmp/uh.pcm');
  const pcm16_2 = new Int16Array(raw2.buffer, raw2.byteOffset, raw2.byteLength / 2);
  const pcm2 = new Float32Array(pcm16_2.length);
  for (let i = 0; i < pcm16_2.length; i++) {
    pcm2[i] = pcm16_2[i];
  }

  const frames2 = extractFeaturesAll(
    pcm2, filterbank, window, cmvnData.means, cmvnData.inverseStdVariances,
    sampleRate, frameLength, frameShift, fftSize, numBins, numFreqBins,
  );

  const probs2 = await runModel(modelPath, frames2, numBins);
  const sm2 = new SM();
  const segs2 = sm2.getSegments(probs2);
  console.log(`\nUH TS Segments: ${JSON.stringify(segs2)}`);
  console.log(`UH Expected: [[91, 246]]`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
