import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFile } from 'fs/promises';
import * as ort from 'onnxruntime-node';
import SpeexResamplerClass from './speexResampler';
import logger from '../../utils/logger';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MODEL_DIR = join(__dirname, '../../../models/firered-vad');

const FIRERED_SAMPLE_RATE = 16000;
const FIRERED_FRAME_SAMPLES = 160;
const FIRERED_FBank_DIM = 80;
const FIRERED_CACHE_DIM = 1024;
const FIRERED_CACHE_LEN = 19;

// Fbank parameters matching Kaldi/kaldi_native_fbank
const FBANK_FRAME_LENGTH_MS = 25;
const FBANK_FRAME_SHIFT_MS = 10;
const FBANK_NUM_MEL_BINS = 80;
const FBANK_SAMPLE_RATE = 16000;
const FBANK_FRAME_LENGTH = Math.round(FBANK_FRAME_LENGTH_MS / 1000 * FBANK_SAMPLE_RATE); // 400
const FBANK_FRAME_SHIFT = Math.round(FBANK_FRAME_SHIFT_MS / 1000 * FBANK_SAMPLE_RATE); // 160

type FireRedVadCallbacks = {
  onSpeechStart: () => void;
  onSpeechEnd: (audio: Float32Array) => void;
};

type FireRedVadInitConfig = {
  speechThreshold: number;
  smoothWindowSize: number;
  minSpeechFrame: number;
  maxSpeechFrame: number;
  minSilenceFrame: number;
  padStartFrame: number;
  gracePeriodMs: number;
};

enum VadState {
  SILENCE = 0,
  POSSIBLE_SPEECH = 1,
  SPEECH = 2,
  POSSIBLE_SILENCE = 3,
}

class StreamVadStateMachine {
  private smoothWindow: number[] = [];
  private smoothWindowSum = 0;
  private readonly smoothWindowSize: number;
  private readonly speechThreshold: number;
  private readonly padStartFrame: number;
  private readonly minSpeechFrame: number;
  private readonly maxSpeechFrame: number;
  private readonly minSilenceFrame: number;

  private state = VadState.SILENCE;
  private frameCnt = 0;
  private speechCnt = 0;
  private silenceCnt = 0;
  private hitMaxSpeech = false;
  private lastSpeechStartFrame = -1;
  private lastSpeechEndFrame = -1;

  get currentFrameCnt(): number {
    return this.frameCnt;
  }

  constructor(config: FireRedVadInitConfig) {
    this.smoothWindowSize = Math.max(1, config.smoothWindowSize);
    this.speechThreshold = config.speechThreshold;
    this.padStartFrame = Math.max(this.smoothWindowSize, config.padStartFrame);
    this.minSpeechFrame = config.minSpeechFrame;
    this.maxSpeechFrame = config.maxSpeechFrame;
    this.minSilenceFrame = config.minSilenceFrame;
  }

  reset(): void {
    this.smoothWindow = [];
    this.smoothWindowSum = 0;
    this.state = VadState.SILENCE;
    this.frameCnt = 0;
    this.speechCnt = 0;
    this.silenceCnt = 0;
    this.hitMaxSpeech = false;
    this.lastSpeechStartFrame = -1;
    this.lastSpeechEndFrame = -1;
  }

  processOneFrame(rawProb: number): {
    isSpeechStart: boolean;
    isSpeechEnd: boolean;
    speechStartFrame: number;
    speechEndFrame: number;
    smoothedProb: number;
    isSpeech: boolean;
  } {
    this.frameCnt++;
    const smoothedProb = this.smoothProb(rawProb);
    const isSpeech = smoothedProb >= this.speechThreshold ? 1 : 0;

    let isSpeechStart = false;
    let isSpeechEnd = false;
    let speechStartFrame = -1;
    let speechEndFrame = -1;

    if (this.hitMaxSpeech) {
      isSpeechStart = true;
      speechStartFrame = this.frameCnt;
      this.lastSpeechStartFrame = speechStartFrame;
      this.hitMaxSpeech = false;
    }

    if (this.state === VadState.SILENCE) {
      if (isSpeech) {
        this.state = VadState.POSSIBLE_SPEECH;
        this.speechCnt += 1;
      } else {
        this.silenceCnt += 1;
        this.speechCnt = 0;
      }
    } else if (this.state === VadState.POSSIBLE_SPEECH) {
      if (isSpeech) {
        this.speechCnt += 1;
        if (this.speechCnt >= this.minSpeechFrame) {
          this.state = VadState.SPEECH;
          isSpeechStart = true;
          speechStartFrame = Math.max(
            1,
            this.frameCnt - this.speechCnt + 1 - this.padStartFrame,
            this.lastSpeechEndFrame + 1,
          );
          this.lastSpeechStartFrame = speechStartFrame;
          this.silenceCnt = 0;
        }
      } else {
        this.state = VadState.SILENCE;
        this.silenceCnt = 1;
        this.speechCnt = 0;
      }
    } else if (this.state === VadState.SPEECH) {
      this.speechCnt += 1;
      if (isSpeech) {
        this.silenceCnt = 0;
        if (this.speechCnt >= this.maxSpeechFrame) {
          this.hitMaxSpeech = true;
          this.speechCnt = 0;
          isSpeechEnd = true;
          speechEndFrame = this.frameCnt;
          speechStartFrame = this.lastSpeechStartFrame;
          this.lastSpeechEndFrame = speechEndFrame;
          this.lastSpeechStartFrame = -1;
        }
      } else {
        this.state = VadState.POSSIBLE_SILENCE;
        this.silenceCnt += 1;
        this.speechCnt = 0;
      }
    } else if (this.state === VadState.POSSIBLE_SILENCE) {
      this.speechCnt += 1;
      if (isSpeech) {
        this.state = VadState.SPEECH;
        this.silenceCnt = 0;
        if (this.speechCnt >= this.maxSpeechFrame) {
          this.hitMaxSpeech = true;
          this.speechCnt = 0;
          isSpeechEnd = true;
          speechEndFrame = this.frameCnt;
          speechStartFrame = this.lastSpeechStartFrame;
          this.lastSpeechEndFrame = speechEndFrame;
          this.lastSpeechStartFrame = -1;
        }
      } else {
        this.silenceCnt += 1;
        if (this.silenceCnt >= this.minSilenceFrame) {
          this.state = VadState.SILENCE;
          isSpeechEnd = true;
          speechEndFrame = this.frameCnt;
          speechStartFrame = this.lastSpeechStartFrame;
          this.lastSpeechEndFrame = speechEndFrame;
          this.lastSpeechStartFrame = -1;
          this.speechCnt = 0;
        }
      }
    }

    return {
      isSpeechStart,
      isSpeechEnd,
      speechStartFrame,
      speechEndFrame,
      smoothedProb,
      isSpeech: Boolean(isSpeech),
    };
  }

  private smoothProb(prob: number): number {
    if (this.smoothWindowSize <= 1) return prob;
    this.smoothWindow.push(prob);
    this.smoothWindowSum += prob;
    if (this.smoothWindow.length > this.smoothWindowSize) {
      this.smoothWindowSum -= this.smoothWindow.shift()!;
    }
    return this.smoothWindowSum / this.smoothWindow.length;
  }
}

// ---- Kaldi CMVN parser ----

function parseKaldiCmvn(buffer: Buffer): { means: Float32Array; inverseStdVariances: Float32Array } {
  // Kaldi .ark format: "KEY <N> MxN [data...] "
  // For cmvn.ark: key "BDM", then 2xD matrix of float64
  let offset = 0;

  // Skip key string (null-terminated)
  const keyEnd = buffer.indexOf(0, offset);
  offset = keyEnd + 1;

  // Read tag: 4 bytes (binary matrix tag)
  if (buffer.readUInt8(offset) !== 4) {
    throw new Error('Unexpected CMVN tag, expected binary matrix');
  }
  offset += 4;

  // Read dimensions: int32 rows, int32 cols
  const rows = buffer.readInt32LE(offset);
  const cols = buffer.readInt32LE(offset + 4);
  offset += 8;

  // Read float64 matrix (2 rows, D+1 cols)
  const dim = cols - 1;
  const matrix = new Float64Array(rows * cols);
  for (let i = 0; i < rows * cols; i++) {
    matrix[i] = buffer.readDoubleLE(offset);
    offset += 8;
  }

  // Parse CMVN: row 0 = sums, row 1 = sum of squares, last column = count
  const count = matrix[dim];
  const means = new Float32Array(dim);
  const inverseStdVariances = new Float32Array(dim);
  const floor = 1e-20;

  for (let d = 0; d < dim; d++) {
    const mean = matrix[d] / count;
    const variance = matrix[dim + d] / count - mean * mean;
    const v = variance < floor ? floor : variance;
    means[d] = mean;
    inverseStdVariances[d] = 1.0 / Math.sqrt(v);
  }

  return { means, inverseStdVariances };
}

// ---- Fbank feature extraction ----

class FbankExtractor {
  private readonly hammingWindow: Float32Array;
  private readonly melFilterbank: Float32Array[][];
  private readonly fftSize: number;
  private readonly numBins: number;
  private readonly frameLength: number;
  private readonly frameShift: number;
  private readonly sampleRate: number;

  // Internal frame buffer: holds the 150 samples of overlap from the previous 25ms window
  private overlapBuffer: Float32Array;

  constructor(sampleRate: number = FBANK_SAMPLE_RATE) {
    this.sampleRate = sampleRate;
    this.frameLength = Math.round(FBANK_FRAME_LENGTH_MS / 1000 * sampleRate);
    this.frameShift = Math.round(FBANK_FRAME_SHIFT_MS / 1000 * sampleRate);
    this.fftSize = 512;
    this.numBins = FBANK_NUM_MEL_BINS;
    this.overlapBuffer = new Float32Array(this.frameLength - this.frameShift);

    this.hammingWindow = this.createHammingWindow(this.frameLength);
    this.melFilterbank = this.createMelFilterbank();
  }

  // Extract one 80-dim frame from 160 new samples (using 250 overlap + 160 new = 410, but we use 400)
  extractFrame(newSamples: Float32Array): Float32Array {
    if (newSamples.length !== this.frameShift) {
      throw new Error(`Expected ${this.frameShift} samples, got ${newSamples.length}`);
    }

    // Combine overlap + new samples to form a 25ms frame
    const frame = new Float32Array(this.frameLength);
    frame.set(this.overlapBuffer, 0);
    frame.set(newSamples, this.frameLength - this.frameShift);

    // Update overlap for next frame
    this.overlapBuffer = frame.subarray(0, this.frameLength - this.frameShift);

    // Apply Hamming window
    for (let i = 0; i < this.frameLength; i++) {
      frame[i] *= this.hammingWindow[i];
    }

    // Compute power spectrum via FFT
    const powerSpectrum = this.computePowerSpectrum(frame);

    // Apply mel filterbank
    const fbank = new Float32Array(this.numBins);
    for (let m = 0; m < this.numBins; m++) {
      let sum = 0;
      const weights = this.melFilterbank[m];
      for (let i = 0; i < weights.length; i++) {
        sum += weights[i][0] * powerSpectrum[weights[i][1]];
      }
      fbank[m] = Math.log(Math.max(sum, 1e-10));
    }

    return fbank;
  }

  reset(): void {
    this.overlapBuffer = new Float32Array(this.frameLength - this.frameShift);
  }

  private createHammingWindow(size: number): Float32Array {
    const window = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      window[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (size - 1));
    }
    return window;
  }

  private createMelFilterbank(): Float32Array[][] {
    const nFFT = this.fftSize;
    const numFreqBins = nFFT / 2 + 1;
    const lowFreqMel = 0;
    const highFreqMel = this.hertzToMel(this.sampleRate / 2);
    const melPoints = new Float32Array(this.numBins + 2);

    for (let i = 0; i < this.numBins + 2; i++) {
      melPoints[i] = (highFreqMel - lowFreqMel) / (this.numBins + 1) * i + lowFreqMel;
    }

    const freqPoints = new Float32Array(this.numBins + 2);
    for (let i = 0; i < this.numBins + 2; i++) {
      freqPoints[i] = this.melToHertz(melPoints[i]);
    }

    const binIndices = new Float32Array(this.numBins + 2);
    for (let i = 0; i < this.numBins + 2; i++) {
      binIndices[i] = Math.floor((nFFT + 1) * freqPoints[i] / this.sampleRate);
    }

    const filterbank: Float32Array[][] = [];
    for (let m = 0; m < this.numBins; m++) {
      const fStart = binIndices[m];
      const fCenter = binIndices[m + 1];
      const fEnd = binIndices[m + 2];
      const entries: Float32Array[] = [];

      for (let f = Math.floor(fStart); f <= Math.floor(fCenter); f++) {
        if (f >= 0 && f < numFreqBins) {
          const weight = (f - fStart) / (fCenter - fStart + 1e-30);
          entries.push(new Float32Array([weight, f]));
        }
      }
      for (let f = Math.floor(fCenter) + 1; f <= Math.floor(fEnd); f++) {
        if (f >= 0 && f < numFreqBins) {
          const weight = (fEnd - f) / (fEnd - fCenter + 1e-30);
          entries.push(new Float32Array([weight, f]));
        }
      }

      filterbank.push(entries);
    }

    return filterbank;
  }

  private computePowerSpectrum(windowed: Float32Array): Float32Array {
    const n = windowed.length;
    const complex = new Float64Array(this.fftSize * 2);

    for (let i = 0; i < n; i++) {
      complex[i * 2] = windowed[i];
    }

    this.rfft(complex, this.fftSize);

    const power = new Float32Array(this.fftSize / 2 + 1);
    for (let i = 0; i <= this.fftSize / 2; i++) {
      const re = complex[i * 2];
      const im = complex[i * 2 + 1];
      power[i] = (re * re + im * im) / this.fftSize;
    }

    return power;
  }

  // In-place radix-2 DFT (Cooley-Tukey)
  private rfft(data: Float64Array, n: number): void {
    const bits = Math.log2(n);
    if (Math.pow(2, bits) !== n) {
      throw new Error('FFT size must be power of 2');
    }

    // Bit-reversal permutation
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

    // Cooley-Tukey FFT
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

  private hertzToMel(hz: number): number {
    return 2595.0 * Math.log10(1 + hz / 700.0);
  }

  private melToHertz(mel: number): number {
    return 700.0 * (Math.pow(10, mel / 2595.0) - 1);
  }
}

// ---- PCM conversion ----

function pcm16ToFloat32(buffer: Buffer): Float32Array {
  const samples = buffer.length / 2;
  const result = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    result[i] = buffer.readInt16LE(i * 2) / 32768;
  }
  return result;
}

// ---- Model paths ----

function resolveModelPath(): string {
  return join(MODEL_DIR, 'fireredvad_stream_vad_with_cache.onnx');
}

function resolveCmvnPath(): string {
  return join(MODEL_DIR, 'cmvn.ark');
}

// ---- Main wrapper ----

export class FireRedVadWrapper {
  private session: ort.InferenceSession | null = null;
  private stateMachine: StreamVadStateMachine;
  private resampler: any = null;
  private readonly callbacks: FireRedVadCallbacks;
  private readonly gracePeriodEnd: number;

  private fbank: FbankExtractor | null = null;
  private cmvnMeans: Float32Array | null = null;
  private cmvnIstd: Float32Array | null = null;
  private cache: Float32Array | null = null;

  private pendingBuffer: Buffer = Buffer.alloc(0);
  private processingQueue: Promise<void> = Promise.resolve();

  private isCollecting = false;
  private speechAudioFloat: Float32Array = new Float32Array(0);

  constructor(sampleRate: number, config: FireRedVadInitConfig, callbacks: FireRedVadCallbacks) {
    this.stateMachine = new StreamVadStateMachine(config);
    this.callbacks = callbacks;
    this.gracePeriodEnd = Date.now() + config.gracePeriodMs;
  }

  async init(): Promise<void> {
    try {
      this.session = await ort.InferenceSession.create(resolveModelPath());
      this.fbank = new FbankExtractor(FIRERED_SAMPLE_RATE);

      const cmvnBuffer = await readFile(resolveCmvnPath());
      const cmvn = parseKaldiCmvn(cmvnBuffer);
      this.cmvnMeans = cmvn.means;
      this.cmvnIstd = cmvn.inverseStdVariances;

      this.cache = new Float32Array(FIRERED_CACHE_DIM * FIRERED_CACHE_LEN);

      logger.info(
        { modelPath: resolveModelPath(), cmvnPath: resolveCmvnPath(), dim: this.cmvnMeans.length },
        'FireRedVAD ONNX model loaded successfully',
      );
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        'Failed to load FireRedVAD ONNX model',
      );
      throw err;
    }
  }

  async initResampler(fromSampleRate: number): Promise<void> {
    if (fromSampleRate === FIRERED_SAMPLE_RATE) return;
    await SpeexResamplerClass.initPromise;
    this.resampler = new SpeexResamplerClass(1, fromSampleRate, FIRERED_SAMPLE_RATE, 3);
    logger.info(
      { fromSampleRate, toSampleRate: FIRERED_SAMPLE_RATE },
      'FireRedVAD resampler initialized',
    );
  }

  processAudio(chunk: Buffer): void {
    if (!this.session || !this.fbank || !this.cmvnMeans || !this.cmvnIstd || !this.cache) return;

    let pcm16: Buffer = chunk;
    if (this.resampler) {
      const resampled = this.resampler.processChunk(chunk);
      if (!resampled || resampled.length === 0) return;
      pcm16 = resampled;
    }

    this.pendingBuffer = Buffer.concat([this.pendingBuffer, pcm16]);

    while (this.pendingBuffer.length >= FIRERED_FRAME_SAMPLES * 2) {
      const frame = this.pendingBuffer.subarray(0, FIRERED_FRAME_SAMPLES * 2);
      this.pendingBuffer = this.pendingBuffer.subarray(FIRERED_FRAME_SAMPLES * 2);

      this.processingQueue = this.processingQueue.then(() =>
        this.processFrame(frame),
      ).catch((err) => {
        logger.error({ error: err.message }, 'FireRedVAD frame processing error');
      });
    }
  }

  private async processFrame(frame: Buffer): Promise<void> {
    if (!this.session || !this.fbank || !this.cmvnMeans || !this.cmvnIstd || !this.cache) return;

    const float32 = pcm16ToFloat32(frame);

    // Extract Fbank features
    const fbankFeat = this.fbank.extractFrame(float32);

    // Apply CMVN normalization
    for (let i = 0; i < FIRERED_FBank_DIM; i++) {
      fbankFeat[i] = (fbankFeat[i] - this.cmvnMeans[i]) * this.cmvnIstd[i];
    }

    // Run ONNX inference
    const inputs = {
      feat: new ort.Tensor('float32', fbankFeat, [1, 1, FIRERED_FBank_DIM]),
      caches_packed: new ort.Tensor('float32', this.cache, [1, FIRERED_CACHE_DIM, FIRERED_CACHE_LEN]),
    };

    const result = await this.session.run(inputs);
    const prob = (result.probs.data as Float32Array)[0];
    const newCache = result.new_caches_packed.data as Float32Array;

    // Update cache
    this.cache.set(newCache);

    const stateResult = this.stateMachine.processOneFrame(prob);

    if (stateResult.isSpeechStart && !this.isCollecting) {
      if (Date.now() < this.gracePeriodEnd) {
        return;
      }
      this.isCollecting = true;
      this.speechAudioFloat = new Float32Array(0);
      this.callbacks.onSpeechStart();
    }

    if (this.isCollecting) {
      const newLen = this.speechAudioFloat.length + float32.length;
      const extended = new Float32Array(newLen);
      extended.set(this.speechAudioFloat, 0);
      extended.set(float32, this.speechAudioFloat.length);
      this.speechAudioFloat = extended;
    }

    if (stateResult.isSpeechEnd && this.isCollecting) {
      this.isCollecting = false;
      this.callbacks.onSpeechEnd(this.speechAudioFloat);
    }
  }

  async flush(): Promise<void> {
    if (this.pendingBuffer.length > 0) {
      this.processAudio(this.pendingBuffer);
      this.pendingBuffer = Buffer.alloc(0);
    }
    await this.processingQueue;
    if (this.isCollecting) {
      this.isCollecting = false;
      if (this.speechAudioFloat.length > 0) {
        this.callbacks.onSpeechEnd(this.speechAudioFloat);
      }
    }
  }

  reset(): void {
    this.stateMachine.reset();
    this.fbank?.reset();
    if (this.cache) {
      this.cache.fill(0);
    }
    this.pendingBuffer = Buffer.alloc(0);
    this.processingQueue = Promise.resolve();
    this.isCollecting = false;
    this.speechAudioFloat = new Float32Array(0);
  }

  destroy(): void {
    this.session = null;
    this.fbank = null;
    this.cache = null;
    this.cmvnMeans = null;
    this.cmvnIstd = null;
  }
}
