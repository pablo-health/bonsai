import { readFileSync } from 'fs';
import * as ort from 'onnxruntime-node';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL_DIR = join(__dirname, '../../models/firered-vad');
const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 160;
const FBANK_DIM = 80;

function parseKaldiCmvn(buffer) {
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
    const variance = matrix[dim + 1 + d] / count - mean * mean;
    const v = variance < 1e-20 ? 1e-20 : variance;
    means[d] = mean;
    inverseStdVariances[d] = 1.0 / Math.sqrt(v);
  }
  return { means, inverseStdVariances };
}

function extractFbank(pcm16, sampleRate) {
  const frameLen = 400;
  const fftSize = 512;
  const nMel = 80;
  const frame = pcm16.slice(-frameLen);
  const windowed = new Float32Array(frameLen);
  for (let i = 0; i < frameLen; i++) {
    windowed[i] = frame[i] * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (frameLen - 1)));
  }
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  re.set(windowed);

  function fft(re, im) {
    const n = re.length;
    if (n <= 1) return;
    const reE = new Float32Array(n/2), imE = new Float32Array(n/2);
    const reO = new Float32Array(n/2), imO = new Float32Array(n/2);
    for (let i = 0; i < n/2; i++) { reE[i]=re[2*i]; imE[i]=im[2*i]; reO[i]=re[2*i+1]; imO[i]=im[2*i+1]; }
    fft(reE, imE); fft(reO, imO);
    for (let k = 0; k < n/2; k++) {
      const a = Math.cos(-2*Math.PI*k/n), b = Math.sin(-2*Math.PI*k/n);
      re[k] = reE[k] + a*reO[k] - b*imO[k];
      im[k] = imE[k] + a*imO[k] + b*reO[k];
    }
  }
  fft(re, im);

  const half = fftSize/2+1;
  const power = new Float32Array(half);
  for (let i = 0; i < half; i++) power[i] = (re[i]*re[i]+im[i]*im[i])/fftSize;

  function hzToMel(f) { return 2595*Math.log10(1+f/700); }
  function melToHz(m) { return 700*(Math.pow(10,m/2595)-1); }
  const melMin = hzToMel(0), melMax = hzToMel(sampleRate/2);
  const melBins = new Float32Array(nMel+2);
  for (let i = 0; i < nMel+2; i++) melBins[i] = melMin+(melMax-melMin)*i/nMel;
  const binEdges = new Float32Array(nMel+2);
  for (let i = 0; i < nMel+2; i++) binEdges[i] = Math.floor((fftSize+1)*melToHz(melBins[i])/sampleRate);

  const melEnergies = new Float32Array(nMel);
  for (let m = 0; m < nMel; m++) {
    let energy = 0;
    const fLow=binEdges[m], fCenter=binEdges[m+1], fHigh=binEdges[m+2];
    for (let k=fLow; k<fCenter; k++) energy += power[k]*(k-fLow)/(fCenter-fLow);
    for (let k=fCenter; k<fHigh; k++) energy += power[k]*(fHigh-k)/(fHigh-fCenter);
    melEnergies[m] = Math.log10(energy+1e-10);
  }
  return melEnergies;
}

// Debug test
const buf = readFileSync('/tmp/test_vad_uh.pcm');
const samples = new Int16Array(buf.buffer);
const pcmChunk = new Float32Array(FRAME_SAMPLES);
for (let j = 0; j < FRAME_SAMPLES; j++) pcmChunk[j] = samples[j]/32768;

console.log('PCM sample range:', Math.min(...pcmChunk), Math.max(...pcmChunk));
console.log('PCM mean:', pcmChunk.reduce((a,b)=>a+b,0)/pcmChunk.length);

const fbankFeat = extractFbank(pcmChunk, SAMPLE_RATE);
console.log('Fbank range:', Math.min(...fbankFeat), Math.max(...fbankFeat));
console.log('Fbank NaN count:', fbankFeat.filter(x => isNaN(x)).length);
console.log('Fbank first 10:', Array.from(fbankFeat.slice(0, 10)));

const cmvn = parseKaldiCmvn(readFileSync(join(MODEL_DIR, 'cmvn.ark')));
console.log('CMVN means range:', Math.min(...cmvn.means), Math.max(...cmvn.means));
console.log('CMVN istd range:', Math.min(...cmvn.inverseStdVariances), Math.max(...cmvn.inverseStdVariances));

for (let j = 0; j < FBANK_DIM; j++) {
  fbankFeat[j] = (fbankFeat[j] - cmvn.means[j]) * cmvn.inverseStdVariances[j];
}
console.log('Normalized range:', Math.min(...fbankFeat), Math.max(...fbankFeat));
console.log('Normalized NaN count:', fbankFeat.filter(x => isNaN(x)).length);
console.log('Normalized first 10:', Array.from(fbankFeat.slice(0, 10)));

// Test with model
const session = await ort.InferenceSession.create(join(MODEL_DIR, 'fireredvad_stream_vad_with_cache.onnx'));
const cache = new Float32Array(8*1*128*19);
const result = await session.run({
  feat: new ort.Tensor('float32', fbankFeat, [1,1,FBANK_DIM]),
  caches_in: new ort.Tensor('float32', cache, [8,1,128,19]),
});
console.log('Output prob:', result.probs.data[0]);
await session.release();
