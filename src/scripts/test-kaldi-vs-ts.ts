import { readFileSync } from 'fs';
import { pcm16ToFloat32, FbankExtractor } from '../services/audio/FireRedVadWrapper';

const pcmData = readFileSync('/tmp/joe.pcm');
const pcmFloat = pcm16ToFloat32(pcmData);

// TS streaming features (with CMVN)
const tsFeaturesCmvn: Float32Array[] = [];
const fbankWithCmvn = new FbankExtractor(16000, undefined); // No CMVN for pre-CMVN comparison
for (let i = 0; i < pcmFloat.length; i += 160) {
  const chunk = new Float32Array(pcmFloat.subarray(i, i + 160));
  if (chunk.length < 160) break;
  const feat = fbankWithCmvn.extractFrame(chunk);
  if (feat.reduce((a, b) => a + Math.abs(b), 0) > 0.001) {
    tsFeaturesCmvn.push(feat);
  }
}

// Kaldi features (pre-CMVN)
const kaldiData = readFileSync('/tmp/kaldi_features_joe.raw');
const kaldiFeatures = new Float32Array(kaldiData.buffer);

console.log(`TS streaming frames (non-zero): ${tsFeaturesCmvn.length}`);
console.log(`Kaldi frames: ${kaldiFeatures.length / 80}`);

// Compare TS streaming (pre-CMVN) vs Kaldi
// TS features have CMVN applied, but Kaldi features don't. Need to extract TS pre-CMVN.
// Actually, let's compare with CMVN disabled on both sides.

// TS with no CMVN (identity transform)
const tsFeaturesNoCmvn: Float32Array[] = [];
const fbankNoCmvn = new FbankExtractor(16000, undefined);
for (let i = 0; i < pcmFloat.length; i += 160) {
  const chunk = new Float32Array(pcmFloat.subarray(i, i + 160));
  if (chunk.length < 160) break;
  const feat = fbankNoCmvn.extractFrame(chunk);
  if (feat.reduce((a, b) => a + Math.abs(b), 0) > 0.001) {
    tsFeaturesNoCmvn.push(feat);
  }
}

console.log(`TS streaming frames (no CMVN, non-zero): ${tsFeaturesNoCmvn.length}`);

// Compare TS (no CMVN) vs Kaldi
let maxDiff = 0;
let maxFrame = 0;
let maxBin = 0;
const compareLen = Math.min(tsFeaturesNoCmvn.length, kaldiFeatures.length / 80);

for (let f = 0; f < compareLen; f++) {
  for (let b = 0; b < 80; b++) {
    const d = Math.abs(tsFeaturesNoCmvn[f][b] - kaldiFeatures[f * 80 + b]);
    if (d > maxDiff) {
      maxDiff = d;
      maxFrame = f;
      maxBin = b;
    }
  }
}

console.log(`\nTS (no CMVN) vs Kaldi: max diff = ${maxDiff.toFixed(8)} at frame ${maxFrame} bin ${maxBin}`);
console.log(`Match (atol 1e-2): ${maxDiff < 1e-2}`);
console.log(`Match (atol 1e-4): ${maxDiff < 1e-4}`);

// Show frame 50 comparison
console.log(`\nFrame 50:`);
console.log(`  TS first 10: [${tsFeaturesNoCmvn[50].slice(0, 10).map(v => v.toFixed(4)).join(', ')}]`);
console.log(`  Kaldi first 10: [${Array.from(kaldiFeatures.subarray(50 * 80, 50 * 80 + 10)).map(v => v.toFixed(4)).join(', ')}]`);
