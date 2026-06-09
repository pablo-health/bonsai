import * as ort from 'onnxruntime-node';
import { fft } from 'fft-js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { logger } from '../../utils/logger';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SAMPLE_RATE = 16000;
const N_FFT = 400;
const FFT_PAD = 512;
const HOP_LENGTH = 160;
const N_MEL = 80;
const F_MIN = 0;
const F_MAX = 8000;
const DURATION_SECONDS = 8;
const MAX_SAMPLES = DURATION_SECONDS * SAMPLE_RATE;
const EXPECTED_FRAMES = 800;

export type SmartTurnResult = {
  isEndpoint: boolean;
  endpointProbability: number;
};

class SmartTurnDetector {
  private session: ort.InferenceSession | null = null;
  private hannWindow: Float32Array | null = null;
  private melFilterbank: Float32Array | null = null;

  async load(modelPath?: string): Promise<void> {
    if (this.session) return;

    const resolvedPath = modelPath || join(__dirname, '../../../models/smart-turn.onnx');

    this.session = await ort.InferenceSession.create(resolvedPath, {
      executionMode: 'sequential',
      interOpNumThreads: 1,
      graphOptimizationLevel: 'all',
    });

    this.hannWindow = this.createHannWindow(N_FFT);
    this.melFilterbank = this.createMelFilterbank(N_FFT, SAMPLE_RATE, N_MEL, F_MIN, F_MAX);

    logger.info(
      { modelPath: resolvedPath, inputNames: this.session.inputNames, outputNames: this.session.outputNames },
      'SmartTurn detector loaded'
    );
  }

  async predict(audio: Float32Array): Promise<SmartTurnResult> {
    if (!this.session || !this.hannWindow || !this.melFilterbank) {
      logger.warn('SmartTurnDetector is not loaded, returning default result');
      return { isEndpoint: false, endpointProbability: 0 };
    }

    const features = this.extractMelSpectrogram(audio, this.hannWindow, this.melFilterbank);
    const tensor = new ort.Tensor('float32', features, [1, N_MEL, EXPECTED_FRAMES]);

    const outputs = await this.session.run({ input_features: tensor });
    const outputKey = Object.keys(outputs)[0];
    const endpointProbability = Number(outputs[outputKey].data[0]);

    return {
      isEndpoint: endpointProbability > 0.5,
      endpointProbability,
    };
  }

  private extractMelSpectrogram(
    audio: Float32Array,
    window: Float32Array,
    filterbank: Float32Array
  ): Float32Array {
    const padded = this.padOrTruncate(audio);
    const numFrames = this.computeNumFrames(padded.length, N_FFT, HOP_LENGTH);
    const numFreqBins = N_FFT / 2 + 1;
    const powerSpectrum = this.computeSTFT(padded, window);
    const melSpectrum = this.applyMelFilterbank(powerSpectrum, filterbank, numFrames, numFreqBins);
    const logMelSpectrum = this.logCompress(melSpectrum);
    const normalized = this.normalize(logMelSpectrum);

    return this.padToExpectedFrames(normalized, numFrames);
  }

  private padOrTruncate(audio: Float32Array): Float32Array {
    if (audio.length > MAX_SAMPLES) {
      return audio.slice(audio.length - MAX_SAMPLES);
    }
    if (audio.length < MAX_SAMPLES) {
      const padded = new Float32Array(MAX_SAMPLES);
      padded.set(audio, MAX_SAMPLES - audio.length);
      return padded;
    }
    return audio;
  }

  private computeNumFrames(signalLength: number, nFft: number, hopLength: number): number {
    return Math.floor((signalLength - nFft) / hopLength) + 1;
  }

  private computeSTFT(signal: Float32Array, window: Float32Array): Float32Array {
    const numFrames = this.computeNumFrames(signal.length, N_FFT, HOP_LENGTH);
    const numFreqBins = N_FFT / 2 + 1;
    const powerSpectrum = new Float32Array(numFrames * numFreqBins);

    for (let frame = 0; frame < numFrames; frame++) {
      const offset = frame * HOP_LENGTH;
      const frameData: Array<[number, number]> = new Array(FFT_PAD);

      for (let i = 0; i < N_FFT; i++) {
        frameData[i] = [signal[offset + i] * window[i], 0];
      }
      for (let i = N_FFT; i < FFT_PAD; i++) {
        frameData[i] = [0, 0];
      }

      const fftResult = fft(frameData);

      for (let bin = 0; bin < numFreqBins; bin++) {
        const real = fftResult[bin][0];
        const imag = fftResult[bin][1];
        powerSpectrum[frame * numFreqBins + bin] = real * real + imag * imag;
      }
    }

    return powerSpectrum;
  }

  private applyMelFilterbank(
    powerSpectrum: Float32Array,
    filterbank: Float32Array,
    numFrames: number,
    numFreqBins: number
  ): Float32Array {
    const melSpectrum = new Float32Array(numFrames * N_MEL);

    for (let frame = 0; frame < numFrames; frame++) {
      for (let mel = 0; mel < N_MEL; mel++) {
        let sum = 0;
        for (let bin = 0; bin < numFreqBins; bin++) {
          sum += powerSpectrum[frame * numFreqBins + bin] * filterbank[mel * numFreqBins + bin];
        }
        melSpectrum[frame * N_MEL + mel] = sum;
      }
    }

    return melSpectrum;
  }

  private logCompress(melSpectrum: Float32Array): Float32Array {
    const logMel = new Float32Array(melSpectrum.length);
    for (let i = 0; i < melSpectrum.length; i++) {
      logMel[i] = Math.log10(Math.max(melSpectrum[i], 1e-10));
    }
    return logMel;
  }

  private normalize(features: Float32Array): Float32Array {
    const normalized = new Float32Array(features.length);
    for (let i = 0; i < features.length; i++) {
      normalized[i] = (features[i] + 4.0) / 4.0;
    }
    return normalized;
  }

  private padToExpectedFrames(features: Float32Array, numFrames: number): Float32Array {
    if (numFrames >= EXPECTED_FRAMES) {
      const truncated = new Float32Array(N_MEL * EXPECTED_FRAMES);
      for (let i = 0; i < EXPECTED_FRAMES; i++) {
        truncated.set(features.slice(i * N_MEL, (i + 1) * N_MEL), i * N_MEL);
      }
      return truncated;
    }

    const padded = new Float32Array(N_MEL * EXPECTED_FRAMES);
    for (let i = 0; i < numFrames; i++) {
      padded.set(features.slice(i * N_MEL, (i + 1) * N_MEL), i * N_MEL);
    }
    return padded;
  }

  private createHannWindow(size: number): Float32Array {
    const window = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
    }
    return window;
  }

  private createMelFilterbank(
    nFft: number,
    sampleRate: number,
    nMels: number,
    fMin: number,
    fMax: number
  ): Float32Array {
    const numFreqBins = nFft / 2 + 1;
    const filterbank = new Float32Array(nMels * numFreqBins);

    const melFMin = this.hzToMel(fMin);
    const melFMax = this.hzToMel(fMax);
    const melPoints = new Array(nMels + 2);
    for (let i = 0; i < nMels + 2; i++) {
      melPoints[i] = melFMin + (melFMax - melFMin) * i / nMels;
    }

    const hzPoints = new Array(nMels + 2);
    for (let i = 0; i < nMels + 2; i++) {
      hzPoints[i] = 700.0 * (Math.exp(melPoints[i] / 1127.0) - 1);
    }

    const binIndices = new Array(nMels + 2);
    for (let i = 0; i < nMels + 2; i++) {
      binIndices[i] = Math.floor((nFft + 1) * hzPoints[i] / sampleRate);
    }

    for (let m = 1; m <= nMels; m++) {
      const fLow = binIndices[m - 1];
      const fCenter = binIndices[m];
      const fHigh = binIndices[m + 1];

      for (let bin = fLow; bin < fCenter; bin++) {
        if (bin >= 0 && bin < numFreqBins && fCenter !== fLow) {
          filterbank[(m - 1) * numFreqBins + bin] = (bin - fLow) / (fCenter - fLow);
        }
      }
      for (let bin = fCenter; bin < fHigh; bin++) {
        if (bin >= 0 && bin < numFreqBins && fHigh !== fCenter) {
          filterbank[(m - 1) * numFreqBins + bin] = (fHigh - bin) / (fHigh - fCenter);
        }
      }
    }

    return filterbank;
  }

  private hzToMel(hz: number): number {
    return 1127.0 * Math.log(1 + hz / 700.0);
  }

  async destroy(): Promise<void> {
    if (this.session) {
      await this.session.release();
      this.session = null;
    }
    this.hannWindow = null;
    this.melFilterbank = null;
  }
}

const instance = new SmartTurnDetector();
export default instance;
