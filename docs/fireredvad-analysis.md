# Full Pipeline Analysis: FireRedVAD

Source: [FireRedTeam/FireRedVAD](https://github.com/FireRedTeam/FireRedVAD)

All file links point to `https://github.com/FireRedTeam/FireRedVAD/blob/main/fireredvad/...`

## Source Files

| File | Purpose |
|---|---|
| [`fireredvad/__init__.py`](https://github.com/FireRedTeam/FireRedVAD/blob/main/fireredvad/__init__.py) | Public API exports |
| [`fireredvad/vad.py`](https://github.com/FireRedTeam/FireRedVAD/blob/main/fireredvad/vad.py) | Non-streaming VAD entry point |
| [`fireredvad/stream_vad.py`](https://github.com/FireRedTeam/FireRedVAD/blob/main/fireredvad/stream_vad.py) | Streaming VAD entry point |
| [`fireredvad/aed.py`](https://github.com/FireRedTeam/FireRedVAD/blob/main/fireredvad/aed.py) | Audio event detection entry point |
| [`fireredvad/core/detect_model.py`](https://github.com/FireRedTeam/FireRedVAD/blob/main/fireredvad/core/detect_model.py) | DFSMN model architecture |
| [`fireredvad/core/audio_feat.py`](https://github.com/FireRedTeam/FireRedVAD/blob/main/fireredvad/core/audio_feat.py) | Fbank + CMVN feature extraction |
| [`fireredvad/core/vad_postprocessor.py`](https://github.com/FireRedTeam/FireRedVAD/blob/main/fireredvad/core/vad_postprocessor.py) | Non-streaming postprocessing pipeline |
| [`fireredvad/core/stream_vad_postprocessor.py`](https://github.com/FireRedTeam/FireRedVAD/blob/main/fireredvad/core/stream_vad_postprocessor.py) | Streaming postprocessing pipeline |
| [`fireredvad/core/constants.py`](https://github.com/FireRedTeam/FireRedVAD/blob/main/fireredvad/core/constants.py) | Frame size constants |

## 1. Audio Input & Feature Extraction

Source: [`core/audio_feat.py`](https://github.com/FireRedTeam/FireRedVAD/blob/main/fireredvad/core/audio_feat.py)

**Input**: 16kHz, 16-bit, mono PCM WAV

**Fbank extraction** — [`KaldifeatFbank`](https://github.com/FireRedTeam/FireRedVAD/blob/main/fireredvad/core/audio_feat.py#L61):
| Param | Value |
|---|---|
| Sample rate | 16000 Hz |
| Frame length | 25ms (400 samples) |
| Frame shift | 10ms (160 samples) |
| Mel bins | 80 |
| Dither | 0 |
| Snip edges | true |

Uses `kaldi_native_fbank` OnlineFbank → output shape `(T, 80)` where `T = floor(audio_samples / 160) + 1`.

**CMVN normalization** — [`CMVN`](https://github.com/FireRedTeam/FireRedVAD/blob/main/fireredvad/core/audio_feat.py#L35):
```
means = stats[0, d] / count
variance = stats[1, d] / count - mean^2
istd = 1.0 / sqrt(variance)     # floored at 1e-20
out = (x - means) * istd
```

Final feature tensor: `(T, 80)`, float32.

## 2. Model Architecture: DFSMN

Source: [`core/detect_model.py`](https://github.com/FireRedTeam/FireRedVAD/blob/main/fireredvad/core/detect_model.py)

**DetectModel** ([`DetectModel`](https://github.com/FireRedTeam/FireRedVAD/blob/main/fireredvad/core/detect_model.py#L9)) — ~588K params, ~2.2 MB float32:

```
Input (T, D=80)
    ↓
DFSMN(T, D→P)
    ↓
Linear(P, odim) → Sigmoid
    ↓
Output (T, odim)  [odim=1 for VAD, odim=3 for AED]
```

**DFSMN** ([`DFSMN`](https://github.com/FireRedTeam/FireRedVAD/blob/main/fireredvad/core/detect_model.py#L30)) — structure: `Rx[H-P(N1,N2,S1,S2)]-MxH`

1. **Entry layer** ([`DFSMN.forward`](https://github.com/FireRedTeam/FireRedVAD/blob/main/fireredvad/core/detect_model.py#L68)): `Linear(D, H) → ReLU → Dropout → Linear(H, P) → ReLU → Dropout → FSMN`
2. **R-1 DFSMN blocks** ([`DFSMNBlock`](https://github.com/FireRedTeam/FireRedVAD/blob/main/fireredvad/core/detect_model.py#L85)), each:
   ```
   input → Linear(P, H) → ReLU → Dropout → Linear(H, P) → FSMN → + residual
   ```
3. **M DNN layers**: `Linear(P, H) → ReLU → Dropout → [Linear(H, H) → ReLU → Dropout]×(M-1)`
4. **Output**: `Linear(H, odim) → sigmoid`

**FSMN** ([`FSMN`](https://github.com/FireRedTeam/FireRedVAD/blob/main/fireredvad/core/detect_model.py#L113)) — the core temporal modeling unit:
```
inputs [N, T, P] → permute [N, P, T]
    ↓
lookback = Conv1d(P, P, kernel=N1, dilation=S1, groups=P, padding=(N1-1)*S1, bias=False)
    ↓                              (depthwise separable, no bias)
memory = residual + lookback
    ↓
if N2 > 0:
    lookahead = Conv1d(P, P, kernel=N2, dilation=S2, groups=P)
    memory += pad(lookahead[:, :, N2*S2:], (0, S2))
    ↓
permute → [N, T, P]
```

The FSMN is essentially a **depthwise dilated convolution** with:
- **Lookback**: causal, captures history up to `(N1-1)*S1` frames
- **Lookahead**: non-causal, captures future context (only for non-streaming)
- **Skip connection**: `memory = input + convolution_output`

**Streaming variant**: maintains `cache` = last `(N1-1)*S1` frames, concatenated before convolution for subsequent chunks. Cache shape: `(N, P, lookback_padding)`.

## 3. Non-Streaming VAD Postprocessing

Source: [`core/vad_postprocessor.py`](https://github.com/FireRedTeam/FireRedVAD/blob/main/fireredvad/core/vad_postprocessor.py)

Pipeline ([`VadPostprocessor.process`](https://github.com/FireRedTeam/FireRedVAD/blob/main/fireredvad/core/vad_postprocessor.py#L42)) — sequential, each step transforms the binary/float decisions:

```
raw_probs [T]
    ↓
_smooth_prob → moving average (window=smooth_window_size, boundary: cumulative average)
    ↓
_apply_threshold → binary (>= speech_threshold)
    ↓
_smooth_preds_with_state_machine → 4-state HMM-like filter:
    SILENCE → POSSIBLE_SPEECH → SPEECH → POSSIBLE_SILENCE → SILENCE
    Transitions gated by min_speech_frame, min_silence_frame
    SPEECH/POSSIBLE_SILENCE = 1, SILENCE/POSSIBLE_SPEECH = 0
    ↓
_fix_smooth_window_start → extends speech start backward by smooth_window_size
    ↓
_merge_short_silence_segments → fills silence gaps < merge_silence_frame with speech
    ↓
_extend_speech_segments → dilates speech segments by extend_speech_frame on both sides
    ↓
_split_long_speech_segments → splits segments > max_speech_frame at lowest-prob points
    ↓
decision_to_segment → frame indices × FRAME_SHIFT_S (0.01s) → (start_s, end_s) tuples
```

### State Machine Detail (Non-Streaming)

| Current State | Input | Action | New State |
|---|---|---|---|
| SILENCE | speech | record speech_start | POSSIBLE_SPEECH |
| POSSIBLE_SPEECH | speech, count >= min_speech | mark [speech_start:t] = 1 | SPEECH |
| POSSIBLE_SPEECH | silence | reset | SILENCE |
| SPEECH | silence | record silence_start | POSSIBLE_SILENCE |
| POSSIBLE_SILENCE | silence, count >= min_silence | reset | SILENCE |
| POSSIBLE_SILENCE | speech | reset | SPEECH |

Decision output: `SPEECH` and `POSSIBLE_SILENCE` → 1, `SILENCE` and `POSSIBLE_SPEECH` → 0.

## 4. Streaming VAD Postprocessing

Source: [`core/stream_vad_postprocessor.py`](https://github.com/FireRedTeam/FireRedVAD/blob/main/fireredvad/core/stream_vad_postprocessor.py)

Same 4-state machine but **online**, processing one frame at a time ([`StreamVadPostprocessor.process_one_frame`](https://github.com/FireRedTeam/FireRedVAD/blob/main/fireredvad/core/stream_vad_postprocessor.py#L50)):

```
raw_prob (float)
    ↓
smooth_prob → sliding window average (deque)
    ↓
apply_threshold → binary
    ↓
state_transition → same 4-state machine, but emits:
    - is_speech_start / is_speech_end events
    - speech_start_frame / speech_end_frame (1-based)
    - pad_start_frame: backs speech start by N frames
    - max_speech_frame hard limit (forces speech end, sets hit_max_speech flag)
    ↓
StreamVadFrameResult per frame
```

Key differences from non-streaming:
- No merge short silence, no extend speech, no split long segments
- `pad_start_frame` replaces `_fix_smooth_window_start`
- Max speech is a hard cutoff (not split at minimum probability)
- Events emitted in real-time as frames arrive
- Default threshold is 0.5 (vs 0.4 for non-streaming)

## 5. AED

Source: [`aed.py`](https://github.com/FireRedTeam/FireRedVAD/blob/main/fireredvad/aed.py)

Same model and feature extraction, but:
- **odim = 3**: speech, singing, music
- **3 independent postprocessors**, one per event type, each with its own threshold
- **event2ratio**: raw frame-level ratio `count(prob >= threshold) / total_frames`
- Returns `event2timestamps` dict + `event2ratio` dict

## 6. Constants Summary

Source: [`core/constants.py`](https://github.com/FireRedTeam/FireRedVAD/blob/main/fireredvad/core/constants.py)

| Constant | Value | Meaning |
|---|---|---|
| SAMPLE_RATE | 16000 | Hz |
| FRAME_LENGTH_MS | 25 | 400 samples |
| FRAME_SHIFT_MS | 10 | 160 samples |
| FRAME_PER_SECONDS | 100 | frames/sec |
| FRAME_SHIFT_S | 0.01 | seconds per frame |

## 7. Chunking for Long Audio

If `T > chunk_max_frame` (default 30000 = 300s), features are split into contiguous chunks, inferred independently, then concatenated. No overlap or boundary smoothing between chunks.

## 8. Default Config Values

### Non-Streaming VAD ([`FireRedVadConfig`](https://github.com/FireRedTeam/FireRedVAD/blob/main/fireredvad/vad.py#L15))

| Param | Default |
|---|---|
| smooth_window_size | 5 |
| speech_threshold | 0.4 |
| min_speech_frame | 20 |
| max_speech_frame | 2000 (20s) |
| min_silence_frame | 20 |
| merge_silence_frame | 0 |
| extend_speech_frame | 0 |
| chunk_max_frame | 30000 (300s) |

### Streaming VAD ([`FireRedStreamVadConfig`](https://github.com/FireRedTeam/FireRedVAD/blob/main/fireredvad/stream_vad.py#L18))

| Param | Default |
|---|---|
| smooth_window_size | 5 |
| speech_threshold | 0.5 |
| pad_start_frame | 5 |
| min_speech_frame | 8 |
| max_speech_frame | 2000 (20s) |
| min_silence_frame | 20 |
| chunk_max_frame | 30000 (300s) |

### Streaming VAD Modes ([`set_mode`](https://github.com/FireRedTeam/FireRedVAD/blob/main/fireredvad/stream_vad.py#L113))

| Mode | Threshold | Min Speech | Min Silence |
|---|---|---|---|
| 0 - VERY PERMISSIVE | 0.3 | 8 | 20 |
| 1 - PERMISSIVE | 0.5 | 10 | 15 |
| 2 - AGGRESSIVE | 0.7 | 15 | 10 |
| 3 - VERY AGGRESSIVE | 0.9 | 20 | 5 |

## 9. Data Flow Diagram

```
WAV (16kHz mono)
    ↓
OnlineFbank(25ms/10ms, 80 mel bins)
    ↓
CMVN normalize (per-bin mean/std from training stats)
    ↓
[T, 80] float32
    ↓
┌─────────────────────────────────────┐
│ DFSMN (R blocks, M DNN layers)      │
│   Entry: Linear→ReLU→Linear→FSMN   │
│   Blocks: Linear→ReLU→Linear→FSMN+  │
│   FSMN = DWConv(dilated) + skip     │
│   DNN: Linear→ReLU × M              │
│   Output: Linear→Sigmoid            │
└─────────────────────────────────────┘
    ↓
[T, 1] probs (VAD) or [T, 3] (AED)
    ↓
┌─────────────────────────────────────┐
│ Postprocessor                        │
│   1. Moving average smooth           │
│   2. Threshold → binary              │
│   3. State machine (min speech/sil)  │
│   4. Fix smooth window start         │
│   5. Merge short silences            │
│   6. Extend speech segments          │
│   7. Split long segments             │
│   8. Frame→time conversion           │
└─────────────────────────────────────┘
    ↓
[(start_s, end_s), ...] segments
```
