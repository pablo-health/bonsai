# FireRedVAD Deep Component Comparison & Rectification Plan

Source: kaldi-native-fbank C++ headers + FireRedVAD Python reference

## Deep Component Comparison

### 1. Mel Scale — CRITICAL MISMATCH

**Reference** (`kaldi-native-fbank/csrc/mel-computations.h`, default `is_librosa=false`):
```cpp
// HTK mel scale (default)
static inline float MelScale(float freq) {
    return 1127.0f * logf(1.0f + freq / 700.0f);
}
static inline float InverseMelScale(float mel_freq) {
    return 700.0f * (expf(mel_freq / 1127.0f) - 1.0f);
}
```

**TS** (`FireRedVadWrapper.ts:407-418`): Uses Slaney mel scale.
```typescript
function melScaleSlaney(freq) {
    if (freq <= 1000) return (freq * 3) / 200;
    return 15 + 14.545078505785561 * Math.log(freq / 1000);
}
```

**Impact**: Mel bin center frequencies differ. Model trained on HTK features. Slaney produces systematically different filterbank weights — largest feature deviation.

### 2. Log Floor — MISMATCH

**Reference** (`kaldi-native-fbank/csrc/feature-fbank.cc:89-92`):
```cpp
auto t = std::max(mel_energies[i], std::numeric_limits<float>::epsilon());
mel_energies[i] = std::log(t);
```
Floor = `FLT_EPSILON` ≈ 1.192e-7. Uses `max(energy, floor)`.

**TS** (`FireRedVadWrapper.ts:381`):
```typescript
fbank[m] = Math.log(fbank[m] + 1e-10);
```
Floor = 1e-10. Uses `log(energy + floor)`.

**Impact**: Minor. Zero-energy bins: ref produces -16.1, TS produces -23.0. Vanishes after CMVN for normal audio.

### 3. CMVN `stdFloor` — MISMATCH

**Reference** (`fireredvad/core/audio_feat.py:35-45`): No std floor. Only variance floored at 1e-20.
```python
istd = 1.0 / sqrt(variance)  # variance floored at 1e-20
```

**TS** (`FireRedVadWrapper.ts:259-268`):
```typescript
const stdFloor = 0.01;
const std = Math.max(Math.sqrt(v), stdFloor);
inverseStdVariances[d] = 1.0 / std;
```

**Impact**: Caps istd at 100. Reference allows istd up to 1e10. Affects dimensions where std is naturally below 0.01.

### 4. Frame Processing Order — CORRECT

Both: DC removal → pre-emphasis → window. Dither omitted (0 at inference).

### 5. Pre-emphasis — CORRECT

Both: per-frame, backward order, `d[0] -= coeff * d[0]`, coeff = 0.97.

### 6. Povey Window — CORRECT

Both: `pow(0.5 - 0.5*cos(2*pi*i/(N-1)), 0.85)`

### 7. FFT Size — CORRECT

Both: 512 (Kaldi rounds 400 to nearest power of 2).

### 8. Mel Filterbank Construction — CORRECT (except mel scale)

Triangular filters, normalized by `2.0 / (rightHz - leftHz)`, sparse storage. Shape matches. Mel breakpoints differ due to Slaney vs HTK.

### 9. Power Spectrum — CORRECT

Both: `re*re + im*im`, no scaling, `use_power=true`.

### 10. Streaming Ring Buffer — CORRECT

Both: 240-sample overlap, wraps correctly, builds 400-sample frames.

### 11. State Machine `silenceCnt` — FUNCTIONALLY EQUIVALENT

`silenceCnt = 0` vs `silenceCnt = 1` on `POSSIBLE_SPEECH → SILENCE` is equivalent — the `SILENCE` handler increments it on the next frame.

### 12. Grace Period State Desync — BUG (not in scope 1-4)

State machine advances during grace period. If `SPEECH` reached, `isCollecting` never set. Collection permanently broken.

### 13. CMVN Matrix Layout — `test-firered.mjs` BUG (not in scope 1-4)

Line 32 reads `matrix[dim + d]` (row 0) instead of `matrix[dim + 1 + d]` (row 1). Produces meaningless variance.

### 14. PCM Scaling — `test-vad-wrapper.ts` BUG (not in scope 1-4)

Line 369-370: `pcm[i] = pcm16[i]` (no `/32768`). Raw int16 values fed to fbank.

## Rectification Plan — Items 1-4

### Fix 1: Replace Slaney mel scale with HTK mel scale
- **File**: `FireRedVadWrapper.ts`
- **Change**: Replace `melScaleSlaney`/`invMelScaleSlaney` with HTK formulas: `1127.0 * ln(1 + f/700)` and `700.0 * (exp(m/1127.0) - 1)`
- **Also**: `test-vad-wrapper.ts` uses Slaney inline — same fix needed

### Fix 2: Remove `stdFloor` from CMVN
- **File**: `FireRedVadWrapper.ts`
- **Change**: Remove `stdFloor = 0.01` and `Math.max(sqrt(v), stdFloor)`. Use `1.0 / sqrt(v)` directly.
- **Also**: `test-vad-wrapper.ts` has same `stdFloor` — same fix needed

### Fix 3: Align log floor to Kaldi
- **File**: `FireRedVadWrapper.ts`
- **Change**: Replace `Math.log(fbank[m] + 1e-10)` with `Math.log(Math.max(fbank[m], 1.192e-7))`
- **Also**: `test-vad-wrapper.ts` has same pattern — same fix needed

### Fix 4: Fix CMVN matrix indexing in `test-firered.mjs`
- **File**: `test-firered.mjs`
- **Change**: Line 32: `matrix[dim + d]` → `matrix[dim + 1 + d]` to read row 1 (sum of squares)

## Files Requiring Changes

| File | Fixes |
|---|---|
| `src/services/audio/FireRedVadWrapper.ts` | 1, 2, 3, D, G |
| `src/scripts/test-vad-wrapper.ts` | 1, 2, 3, F |
| `src/scripts/test-firered.mjs` | 4 |

## Fix D: Grace Period State Desync

**Problem**: `stateMachine.processOneFrame(prob)` advances state before grace check. If SPEECH state reached during grace, `isSpeechStart` fires but we `return` early. `isCollecting` never set. After grace ends, state is already SPEECH so `isSpeechStart` won't fire again. Collection permanently broken.

**Fix**: Added `speechStartPending` flag. When `isSpeechStart` fires during grace, set flag and return. On every subsequent frame, check flag first — if grace has ended, begin collection. Exposed `currentState` getter on state machine for debugging.

## Fix F: Raw PCM in `test-vad-wrapper.ts`

**Problem**: Lines 364 and 404: `pcm[i] = pcm16[i]` — raw int16 values (e.g. -32768..32767) fed directly to fbank. Should be normalized float32 (-1..1).

**Fix**: `pcm[i] = pcm16[i] / 32768` (both audio files).

## Fix G: Audio Pre-Roll Buffer

**Problem**: `padStartFrame` config backs the speech start frame by N frames (e.g. 5 = 50ms). But audio collection only starts when `isSpeechStart` fires. The backed 50ms of audio is missing from the output.

**Fix**: Ring buffer of `padStartFrame * 160` float32 samples. Every frame stores its 160 samples into the ring buffer. On speech start, `getPreRollAudio()` drains the ring buffer in chronological order to become the initial `speechAudioFloat`. `flush()` also handles `speechStartPending` by triggering collection with pre-roll audio.
