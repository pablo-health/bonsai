/**
 * Tells the caller from the room, using the one thing that separates them physically: distance.
 *
 * The caller's mouth is centimetres from the microphone. Everyone else in a concert queue, an
 * airport lounge or an open-plan office is metres away. That difference survives in the signal
 * INDEPENDENTLY OF LOUDNESS, which matters because loudness is exactly what a phone's automatic
 * gain control spends its time destroying - and because level and duration provably cannot do this
 * job. Swept against the corpus on 2026-08-28, no value of the VAD's `minSpeechFrame` separates a
 * crowd surge from a caller saying "Kurt": the two have the same duration and the same level, so a
 * detector built on those two quantities is being asked for a distinction its inputs do not carry.
 *
 * Three features, chosen because they degrade differently with distance rather than with gain:
 *
 *   SPECTRAL TILT - the one that works, and NOT for the reason first assumed. The textbook
 *   argument is that distance is low-pass, so a far source should arrive DULLER and therefore
 *   more low-band. Measured against the corpus, the sign is the other way round: a near talker on
 *   a phone is dominated by voicing energy in the low band, while a room - concert crowd, PA hiss,
 *   lounge air handling - is broadband and comparatively rich above 1 kHz. So high tilt means
 *   near, and it is measured inside the telephone band only, since nothing outside 300-3400 Hz
 *   survives the codec anyway.
 *
 *   MODULATION DEPTH - MEASURED AND NOT USEFUL, kept because a null result is worth keeping.
 *   The hypothesis was that one talker close up modulates hard at syllabic rates while babble,
 *   being the sum of many uncorrelated envelopes, flattens toward a constant. On the corpus the
 *   values run the other way: room-only segments score HIGHER (0.48-0.90) than caller segments
 *   (0.12-0.64). A VAD-triggering burst is a single envelope hump, which is itself strong
 *   low-frequency envelope content, so on segments this short the measure mostly reports "the
 *   VAD fired" rather than "one person is talking". It is reported and deliberately NOT used in
 *   the decision.
 *
 *   ONSET SHARPNESS. Near-field is direct sound, so attacks are fast; a reverberant tail smears
 *   them. On the corpus this does not separate caller from room in general, but a value near zero
 *   is a reliable marker of heavily compressed audio - the megaphone and PA segments score 0.001
 *   to 0.15, because a compressor is a device for removing exactly this. Reported, not decided on.
 *
 * NO ENROLMENT, which is the whole point of preferring this to speaker identification. It works
 * from the first syllable of the first turn, so it has no cold-start problem - and the cold start
 * is precisely when a screening call needs it, because the caller's name is the first thing asked
 * for and the first thing a bystander can ruin.
 *
 * HOW WELL IT WORKS, on the 2026-08-27/28 corpus, using segments the VAD actually opened and
 * labelling each by whether the recogniser could hear anything in it. 15 caller segments across a
 * concert, an airport lounge and a quiet hotel; 7 room-only segments from the concert recording in
 * which the caller was silent - those transcribe to the empty string, which is what makes them
 * ground truth rather than opinion. At a tilt threshold of -0.75:
 *
 *     caller segments misread as the room:  0 of 15
 *     room-only segments admitted as near:  1 of 7
 *
 * The threshold sits in the middle of a flat region running from -0.90 to -0.60 over which those
 * numbers do not change, which is why it is -0.75 and not the edge of the separation.
 *
 * THIS IS A DETECTOR, NOT A GATE, and the distinction is not stylistic. Every rule in this system
 * that could stop the agent responding has at some point become a suppression path with no exit,
 * four separate times. Nothing here may decide on its own that a caller did not speak. It reports
 * a score; the caller decides what to do with it, and the only sanctioned uses are to demand more
 * evidence before INTERRUPTING the agent, and to confirm the end of a turn that other signals have
 * already ended.
 */

/** Frame length for the envelope and the spectrum, in milliseconds. */
const FRAME_MS = 10;
/** FFT size at 16 kHz: 32ms of context, a power of two, and the same size FireRed uses. */
const FFT_SIZE = 512;

/** The telephone band. Nothing outside this survives the codec, so nothing outside it is measured. */
const BAND_LOW_HZ = 300;
const BAND_SPLIT_HZ = 1000;
const BAND_HIGH_HZ = 3400;

/** Syllabic rate - where speech modulates hardest. Reported only; see the header for why. */
const MODULATION_LOW_HZ = 2;
const MODULATION_HIGH_HZ = 16;

/**
 * Frames quieter than this fraction of the segment's peak are excluded from the tilt and onset
 * measurements. Silence has no spectrum worth measuring and would drag both features toward the
 * noise floor, which is the opposite of what they are for.
 */
const ACTIVE_FRAME_FLOOR = 0.15;

/** What the signal says about how far away whoever produced it was standing. */
export type ProximityFeatures = {
  /**
   * Log ratio of low-band to high-band energy inside the telephone band. HIGHER MEANS NEARER - a
   * close talker is dominated by low-band voicing energy, a room is broadband. This is the only
   * feature the decision uses.
   */
  spectralTilt: number;
  /**
   * Fraction of the envelope's energy at syllabic rates. Reported for the record; measured against
   * the corpus and found to run the wrong way, so nothing decides on it. See the file header.
   */
  modulationDepth: number;
  /** 90th-percentile positive envelope slope, normalised by mean level. Higher means direct sound. */
  onsetSharpness: number;
  /** Frames that cleared the activity floor. Below about 8 the tilt is not stable enough to read. */
  activeFrames: number;
};

/** In-place real FFT, decimation in time. `data` is interleaved re/im, length 2n. */
function fft(data: Float64Array, n: number): void {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = data[i * 2]; data[i * 2] = data[j * 2]; data[j * 2] = t;
      t = data[i * 2 + 1]; data[i * 2 + 1] = data[j * 2 + 1]; data[j * 2 + 1] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle), wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const aRe = data[(i + k) * 2], aIm = data[(i + k) * 2 + 1];
        const bIdx = (i + k + len / 2) * 2;
        const bRe = data[bIdx] * curRe - data[bIdx + 1] * curIm;
        const bIm = data[bIdx] * curIm + data[bIdx + 1] * curRe;
        data[(i + k) * 2] = aRe + bRe; data[(i + k) * 2 + 1] = aIm + bIm;
        data[bIdx] = aRe - bRe; data[bIdx + 1] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/** Energy in a frequency range of one frame's power spectrum. */
function bandEnergy(power: Float64Array, sampleRate: number, fromHz: number, toHz: number): number {
  const binHz = sampleRate / FFT_SIZE;
  const from = Math.max(1, Math.round(fromHz / binHz));
  const to = Math.min(power.length - 1, Math.round(toHz / binHz));
  let sum = 0;
  for (let i = from; i <= to; i++) sum += power[i];
  return sum;
}

/**
 * Measures how near the source of a stretch of audio was.
 *
 * @param pcm - 16-bit signed little-endian PCM, mono.
 * @param sampleRate - Sample rate of `pcm`.
 * @returns The three features, plus how much of the segment was loud enough to measure.
 */
export function proximityFeatures(pcm: Buffer, sampleRate = 16000): ProximityFeatures {
  const frameSamples = Math.round((sampleRate * FRAME_MS) / 1000);
  const frameCount = Math.floor(pcm.length / 2 / frameSamples);
  if (frameCount < 4) {
    return { spectralTilt: 0, modulationDepth: 0, onsetSharpness: 0, activeFrames: 0 };
  }

  // Pass one: the envelope, as per-frame RMS. Everything else is derived from this or from the
  // frames it marks as active.
  const envelope = new Float64Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    let sum = 0;
    for (let i = 0; i < frameSamples; i++) {
      const s = pcm.readInt16LE((f * frameSamples + i) * 2) / 32768;
      sum += s * s;
    }
    envelope[f] = Math.sqrt(sum / frameSamples);
  }

  let peak = 0;
  for (const v of envelope) if (v > peak) peak = v;
  const floor = peak * ACTIVE_FRAME_FLOOR;

  // Pass two: spectral tilt over the active frames only.
  const scratch = new Float64Array(FFT_SIZE * 2);
  const power = new Float64Array(FFT_SIZE / 2 + 1);
  let lowTotal = 0, highTotal = 0, activeFrames = 0;

  for (let f = 0; f < frameCount; f++) {
    if (envelope[f] < floor) continue;
    activeFrames++;

    // A Hann window over FFT_SIZE samples centred on the frame, so the spectrum is not dominated
    // by the discontinuity at the frame edges.
    const centre = f * frameSamples + frameSamples / 2;
    const start = Math.round(centre - FFT_SIZE / 2);
    scratch.fill(0);
    for (let i = 0; i < FFT_SIZE; i++) {
      const idx = start + i;
      if (idx < 0 || idx >= pcm.length / 2) continue;
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
      scratch[i * 2] = (pcm.readInt16LE(idx * 2) / 32768) * w;
    }
    fft(scratch, FFT_SIZE);
    for (let i = 0; i <= FFT_SIZE / 2; i++) {
      power[i] = scratch[i * 2] * scratch[i * 2] + scratch[i * 2 + 1] * scratch[i * 2 + 1];
    }
    lowTotal += bandEnergy(power, sampleRate, BAND_LOW_HZ, BAND_SPLIT_HZ);
    highTotal += bandEnergy(power, sampleRate, BAND_SPLIT_HZ, BAND_HIGH_HZ);
  }

  const spectralTilt = activeFrames > 0 ? Math.log10((lowTotal + 1e-12) / (highTotal + 1e-12)) : 0;

  // Modulation: how much of the envelope's variation happens at syllabic rates. A naive DFT is
  // fine here - the envelope is one value per 10ms, so even a long turn is a few hundred points.
  const envRate = 1000 / FRAME_MS;
  let envMean = 0;
  for (const v of envelope) envMean += v;
  envMean /= frameCount;

  let syllabic = 0, total = 0;
  const maxK = Math.floor(frameCount / 2);
  for (let k = 1; k <= maxK; k++) {
    const hz = (k * envRate) / frameCount;
    let re = 0, im = 0;
    for (let n = 0; n < frameCount; n++) {
      const angle = (-2 * Math.PI * k * n) / frameCount;
      const centred = envelope[n] - envMean;
      re += centred * Math.cos(angle);
      im += centred * Math.sin(angle);
    }
    const magnitude = re * re + im * im;
    total += magnitude;
    if (hz >= MODULATION_LOW_HZ && hz <= MODULATION_HIGH_HZ) syllabic += magnitude;
  }
  const modulationDepth = total > 0 ? syllabic / total : 0;

  // Onset sharpness: the steep rises, not the average rise, because a single hard consonant onset
  // is the evidence. Normalised by mean level so it does not simply restate loudness.
  const slopes: number[] = [];
  for (let f = 1; f < frameCount; f++) {
    const rise = envelope[f] - envelope[f - 1];
    if (rise > 0) slopes.push(rise);
  }
  slopes.sort((a, b) => a - b);
  const p90 = slopes.length > 0 ? slopes[Math.min(slopes.length - 1, Math.floor(slopes.length * 0.9))] : 0;
  const onsetSharpness = envMean > 0 ? p90 / envMean : 0;

  return { spectralTilt, modulationDepth, onsetSharpness, activeFrames };
}

/**
 * Tilt above which a segment is treated as the caller rather than the room.
 *
 * Chosen from the middle of the flat region described at the top of this file, not from the edge
 * of the separation, so a corpus that shifts slightly does not walk straight off a cliff.
 */
export const NEAR_FIELD_TILT_THRESHOLD = -0.75;

/**
 * Whether this stretch of audio sounds like the person holding the phone.
 *
 * Read the "detector, not a gate" note above before using this. The two sanctioned uses are to
 * demand more evidence before INTERRUPTING the agent, and to confirm the end of a turn that other
 * signals have already ended. It must never be the reason a caller goes unanswered: a false
 * "that was the room" while the agent waits for a name is the failure this whole investigation has
 * been about, and it is why the threshold is set where it costs zero caller segments rather than
 * where it catches the most room.
 *
 * @param pcm - 16-bit signed little-endian PCM of one VAD segment.
 * @param sampleRate - Sample rate of `pcm`.
 * @returns Null when the segment is too short or too quiet to judge - which must be read as
 *   "unknown", never as "the room".
 */
export function isNearField(pcm: Buffer, sampleRate = 16000): boolean | null {
  const features = proximityFeatures(pcm, sampleRate);
  // Below about 20 active frames the tilt is computed from a couple of hundred milliseconds of
  // voiced audio and is not stable. Saying so is better than guessing.
  if (features.activeFrames < 8) return null;
  return features.spectralTilt > NEAR_FIELD_TILT_THRESHOLD;
}
