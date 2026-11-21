import type { MicProfile } from '../../shared/types';

export interface DecodedWav {
  sampleRate: number;
  samples: Int16Array;
}

export interface WavStats {
  durationMs: number;
  rms: number;
  peak: number;
  isSilent: boolean;
}

export interface CompactSilenceOptions {
  rmsThreshold?: number;
  minPauseMs?: number;
  targetPauseMs?: number;
  fadeMs?: number;
}

const DEFAULT_SAMPLE_RATE = 16000;
export const QUIET_SILENCE_RMS_THRESHOLD = 50;
export const NOISY_SILENCE_RMS_THRESHOLD = 120; // ~ -48.7 dBFS over 20ms frames
export const DEFAULT_MAX_CHUNK_SEC = 90;
export const DEFAULT_MIN_CHUNK_SEC = 45;

export const HIGH_PASS_CUTOFF_HZ = 90;
export const LOW_SHELF_FREQ_HZ = 240;
export const LOW_SHELF_GAIN_DB = -4;
export const HIGH_SHELF_FREQ_HZ = 1400;
export const HIGH_SHELF_GAIN_DB = 8;
export const ADAPTIVE_NOISE_FLOOR_MULTIPLIER = 2.2;
export const ADAPTIVE_RMS_THRESHOLD_CAP = 1800;
export const MIN_ACTIVE_SPEECH_MS = 140; // Require >= 7 x 20ms active frames

const WAV_SOFT_LIMIT_THRESHOLD = 0.75;
const WAV_SOFT_LIMIT_CEILING = 0.95;

interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function makeHighPassBiquad(
  sampleRate: number,
  cutoffHz = HIGH_PASS_CUTOFF_HZ,
  q = Math.SQRT1_2
): BiquadCoeffs | null {
  if (sampleRate <= 0 || cutoffHz <= 0 || cutoffHz >= sampleRate * 0.45) {
    return null;
  }
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = sinW0 / (2 * q);

  const a0 = 1 + alpha;
  return {
    b0: (1 + cosW0) / 2 / a0,
    b1: -(1 + cosW0) / a0,
    b2: (1 + cosW0) / 2 / a0,
    a1: (-2 * cosW0) / a0,
    a2: (1 - alpha) / a0,
  };
}

function makeLowShelfBiquad(
  sampleRate: number,
  freqHz = LOW_SHELF_FREQ_HZ,
  gainDb = LOW_SHELF_GAIN_DB,
  slope = 1
): BiquadCoeffs | null {
  if (sampleRate <= 0 || freqHz <= 0 || freqHz >= sampleRate * 0.45) {
    return null;
  }
  const a = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * freqHz) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = (sinW0 / 2) * Math.sqrt((a + 1 / a) * (1 / slope - 1) + 2);
  const twoSqrtAAlpha = 2 * Math.sqrt(a) * alpha;

  const a0 = a + 1 + (a - 1) * cosW0 + twoSqrtAAlpha;
  return {
    b0: (a * (a + 1 - (a - 1) * cosW0 + twoSqrtAAlpha)) / a0,
    b1: (2 * a * (a - 1 - (a + 1) * cosW0)) / a0,
    b2: (a * (a + 1 - (a - 1) * cosW0 - twoSqrtAAlpha)) / a0,
    a1: (-2 * (a - 1 + (a + 1) * cosW0)) / a0,
    a2: (a + 1 + (a - 1) * cosW0 - twoSqrtAAlpha) / a0,
  };
}

function makeHighShelfBiquad(
  sampleRate: number,
  freqHz = HIGH_SHELF_FREQ_HZ,
  gainDb = HIGH_SHELF_GAIN_DB,
  slope = 1
): BiquadCoeffs | null {
  if (sampleRate <= 0 || freqHz <= 0 || freqHz >= sampleRate * 0.45) {
    return null;
  }
  const a = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * freqHz) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = (sinW0 / 2) * Math.sqrt((a + 1 / a) * (1 / slope - 1) + 2);
  const twoSqrtAAlpha = 2 * Math.sqrt(a) * alpha;

  const a0 = a + 1 - (a - 1) * cosW0 + twoSqrtAAlpha;
  return {
    b0: (a * (a + 1 + (a - 1) * cosW0 + twoSqrtAAlpha)) / a0,
    b1: (-2 * a * (a - 1 + (a + 1) * cosW0)) / a0,
    b2: (a * (a + 1 + (a - 1) * cosW0 - twoSqrtAAlpha)) / a0,
    a1: (2 * (a - 1 - (a + 1) * cosW0)) / a0,
    a2: (a + 1 - (a - 1) * cosW0 - twoSqrtAAlpha) / a0,
  };
}

function processBiquadInPlace(buf: Float64Array, coeffs: BiquadCoeffs): void {
  const { b0, b1, b2, a1, a2 } = coeffs;
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    buf[i] = y;
  }
}

function softProtectNormalized(x: number): number {
  if (!Number.isFinite(x)) return 0;
  const abs = Math.abs(x);
  if (abs <= WAV_SOFT_LIMIT_THRESHOLD) return x;
  const headroom = WAV_SOFT_LIMIT_CEILING - WAV_SOFT_LIMIT_THRESHOLD;
  return (
    Math.sign(x) *
    (WAV_SOFT_LIMIT_THRESHOLD + headroom * Math.tanh((abs - WAV_SOFT_LIMIT_THRESHOLD) / headroom))
  );
}

function float64ToInt16Protected(buf: Float64Array): Int16Array {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const limited = softProtectNormalized(buf[i]);
    const scaled = limited < 0 ? Math.round(limited * 32768) : Math.round(limited * 32767);
    out[i] = Math.max(-32768, Math.min(32767, scaled));
  }
  return out;
}

function applyHighPassFloat64RawUnits(
  samples: Int16Array,
  sampleRate: number,
  cutoffHz = HIGH_PASS_CUTOFF_HZ
): Float64Array {
  const buf = new Float64Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    buf[i] = samples[i];
  }
  const hp = makeHighPassBiquad(sampleRate, cutoffHz);
  if (hp) {
    processBiquadInPlace(buf, hp);
  }
  return buf;
}

/**
 * Applies a 2nd-order Butterworth high-pass filter (default 90 Hz) with soft peak protection.
 */
export function applyHighPassFilter(
  samples: Int16Array,
  sampleRate: number,
  cutoffHz = HIGH_PASS_CUTOFF_HZ
): Int16Array {
  if (samples.length === 0 || sampleRate <= 0) {
    return new Int16Array(samples);
  }
  const buf = new Float64Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    buf[i] = samples[i] / 32768;
  }
  const hp = makeHighPassBiquad(sampleRate, cutoffHz);
  if (hp) {
    processBiquadInPlace(buf, hp);
  }
  return float64ToInt16Protected(buf);
}

/**
 * Applies a 90 Hz high-pass filter to a WAV buffer to remove sub-bass rumble and DC offset.
 */
export function applyHighPassWav(wavBuf: Buffer, cutoffHz = HIGH_PASS_CUTOFF_HZ): Buffer {
  const { sampleRate, samples } = decodeMonoWavSamples(wavBuf);
  if (samples.length === 0 || sampleRate <= 0) return wavBuf;
  return encodePcm16MonoWav(applyHighPassFilter(samples, sampleRate, cutoffHz), sampleRate);
}

/**
 * Applies speech Tilt EQ (-4 dB low shelf <240 Hz, +8 dB high shelf >1.4 kHz),
 * optionally preceded by a 90 Hz high-pass filter, with soft tanh peak protection.
 */
export function applySpeechEqSamples(
  samples: Int16Array,
  sampleRate: number,
  options?: { includeHighPass?: boolean }
): Int16Array {
  if (samples.length === 0 || sampleRate <= 0) {
    return new Int16Array(samples);
  }
  const buf = new Float64Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    buf[i] = samples[i] / 32768;
  }
  if (options?.includeHighPass !== false) {
    const hp = makeHighPassBiquad(sampleRate, HIGH_PASS_CUTOFF_HZ);
    if (hp) processBiquadInPlace(buf, hp);
  }
  const lowShelf = makeLowShelfBiquad(sampleRate, LOW_SHELF_FREQ_HZ, LOW_SHELF_GAIN_DB);
  if (lowShelf) processBiquadInPlace(buf, lowShelf);

  const highShelf = makeHighShelfBiquad(sampleRate, HIGH_SHELF_FREQ_HZ, HIGH_SHELF_GAIN_DB);
  if (highShelf) processBiquadInPlace(buf, highShelf);

  return float64ToInt16Protected(buf);
}

/**
 * Applies speech Tilt EQ (-4 dB low shelf @ 240 Hz, +8 dB high shelf @ 1.4 kHz),
 * optionally preceded by 90 Hz HPF (default true).
 */
export function applySpeechEqWav(
  wavBuf: Buffer,
  options?: { includeHighPass?: boolean }
): Buffer {
  const { sampleRate, samples } = decodeMonoWavSamples(wavBuf);
  if (samples.length === 0 || sampleRate <= 0) return wavBuf;
  return encodePcm16MonoWav(applySpeechEqSamples(samples, sampleRate, options), sampleRate);
}

/**
 * Full deterministic speech preprocessing: 90 Hz HPF + Tilt EQ (-4 dB <240 Hz, +8 dB >1.4 kHz).
 */
export function preprocessSpeechWav(wavBuf: Buffer): Buffer {
  return applySpeechEqWav(wavBuf, { includeHighPass: true });
}

export function getSilenceRmsThreshold(micProfile?: MicProfile): number {
  return micProfile === 'quiet' ? QUIET_SILENCE_RMS_THRESHOLD : NOISY_SILENCE_RMS_THRESHOLD;
}

function analyzeSpeechFrames(
  samples: Int16Array,
  sampleRate: number,
  baseThreshold: number
): { effectiveThreshold: number; activeFlags: boolean[] } {
  const numSamples = samples.length;
  if (numSamples === 0 || sampleRate <= 0) {
    return { effectiveThreshold: baseThreshold, activeFlags: [] };
  }

  const hpSamples = applyHighPassFloat64RawUnits(samples, sampleRate, HIGH_PASS_CUTOFF_HZ);
  const frameLen = Math.max(1, Math.floor(sampleRate * 0.02)); // 20 ms frames
  const numFrames = Math.ceil(numSamples / frameLen);
  const frameRms = new Array<number>(numFrames);
  const floorCandidates: number[] = [];
  const minFloorFrameLen = numSamples >= frameLen ? Math.max(1, Math.floor(frameLen / 2)) : 1;

  for (let frameIdx = 0; frameIdx < numFrames; frameIdx++) {
    const start = frameIdx * frameLen;
    const end = Math.min(numSamples, start + frameLen);
    const len = end - start;
    let sumSq = 0;
    for (let i = start; i < end; i++) {
      const s = hpSamples[i];
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, len));
    frameRms[frameIdx] = rms;
    if (len >= minFloorFrameLen) {
      floorCandidates.push(rms);
    }
  }

  const sortedFloor = (floorCandidates.length > 0 ? floorCandidates : frameRms).slice().sort((a, b) => a - b);
  const p15Idx = Math.min(sortedFloor.length - 1, Math.floor((sortedFloor.length - 1) * 0.15));
  const noiseFloor = sortedFloor[p15Idx] ?? 0;
  const effectiveThreshold = Math.max(
    baseThreshold,
    Math.min(ADAPTIVE_RMS_THRESHOLD_CAP, Math.round(noiseFloor * ADAPTIVE_NOISE_FLOOR_MULTIPLIER))
  );

  const activeFlags = new Array<boolean>(numFrames);
  for (let i = 0; i < numFrames; i++) {
    activeFlags[i] = frameRms[i] >= effectiveThreshold;
  }

  return { effectiveThreshold, activeFlags };
}

/**
 * Computes an adaptive 20ms RMS threshold from the 15th-percentile noise floor
 * after 90 Hz high-pass filtering: `max(baseThreshold, min(1800, round(noiseFloor * 2.2)))`.
 */
export function computeAdaptiveRmsThreshold(
  samples: Int16Array,
  sampleRate: number,
  baseThreshold: number
): number {
  return analyzeSpeechFrames(samples, sampleRate, baseThreshold).effectiveThreshold;
}

/**
 * Encodes mono 16-bit PCM samples (from Int16Array or normalized Float32Array [-1, 1])
 * into a standard 44-byte RIFF/WAVE PCM16 buffer.
 */
export function encodePcm16MonoWav(
  samples: Int16Array | Float32Array,
  sampleRate = DEFAULT_SAMPLE_RATE
): Buffer {
  const numSamples = samples.length;
  const dataSize = numSamples * 2;
  const buf = Buffer.allocUnsafe(44 + dataSize);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM format
  buf.writeUInt16LE(1, 22); // Mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // Byte rate = sampleRate * 1 * 2
  buf.writeUInt16LE(2, 32); // Block align
  buf.writeUInt16LE(16, 34); // Bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);

  if (samples instanceof Int16Array) {
    for (let i = 0; i < numSamples; i++) {
      buf.writeInt16LE(samples[i], 44 + i * 2);
    }
  } else {
    for (let i = 0; i < numSamples; i++) {
      const raw = samples[i];
      const clamped = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
      const intVal = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, intVal)), 44 + i * 2);
    }
  }

  return buf;
}

/**
 * Decodes a RIFF/WAVE buffer into mono Int16Array samples and its sample rate.
 * Supports 16-bit PCM (mono or multi-channel downmixed) and 32-bit IEEE float.
 */
export function decodeMonoWavSamples(wavBuf: Buffer): DecodedWav {
  if (wavBuf.length < 12) {
    throw new Error('Invalid WAV buffer: too short');
  }
  if (wavBuf.toString('ascii', 0, 4) !== 'RIFF' || wavBuf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Invalid WAV buffer: missing RIFF/WAVE header');
  }

  let pos = 12;
  let audioFormat = 1;
  let numChannels = 1;
  let sampleRate = DEFAULT_SAMPLE_RATE;
  let bitsPerSample = 16;
  let fmtFound = false;
  let dataOffset = -1;
  let dataSize = 0;

  while (pos + 8 <= wavBuf.length) {
    const id = wavBuf.toString('ascii', pos, pos + 4);
    const size = wavBuf.readUInt32LE(pos + 4);
    const bodyStart = pos + 8;

    if (id === 'fmt ' && bodyStart + 16 <= wavBuf.length) {
      fmtFound = true;
      audioFormat = wavBuf.readUInt16LE(bodyStart);
      numChannels = wavBuf.readUInt16LE(bodyStart + 2);
      sampleRate = wavBuf.readUInt32LE(bodyStart + 4);
      bitsPerSample = wavBuf.readUInt16LE(bodyStart + 14);
    } else if (id === 'data') {
      dataOffset = bodyStart;
      dataSize = Math.min(size, Math.max(0, wavBuf.length - dataOffset));
      break;
    }

    pos = bodyStart + size + (size % 2);
  }

  if (!fmtFound || dataOffset < 0) {
    throw new Error('Invalid WAV buffer: missing fmt or data chunk');
  }
  if (numChannels < 1) {
    throw new Error(`Invalid WAV buffer: unsupported channel count ${numChannels}`);
  }

  if (audioFormat === 1 && bitsPerSample === 16) {
    const bytesPerFrame = numChannels * 2;
    const numFrames = Math.floor(dataSize / bytesPerFrame);
    const samples = new Int16Array(numFrames);

    if (numChannels === 1) {
      for (let i = 0; i < numFrames; i++) {
        samples[i] = wavBuf.readInt16LE(dataOffset + i * 2);
      }
    } else {
      for (let i = 0; i < numFrames; i++) {
        let sum = 0;
        const frameOffset = dataOffset + i * bytesPerFrame;
        for (let ch = 0; ch < numChannels; ch++) {
          sum += wavBuf.readInt16LE(frameOffset + ch * 2);
        }
        samples[i] = Math.round(sum / numChannels);
      }
    }
    return { sampleRate, samples };
  }

  if (audioFormat === 3 && bitsPerSample === 32) {
    const bytesPerFrame = numChannels * 4;
    const numFrames = Math.floor(dataSize / bytesPerFrame);
    const samples = new Int16Array(numFrames);
    for (let i = 0; i < numFrames; i++) {
      let sum = 0;
      const frameOffset = dataOffset + i * bytesPerFrame;
      for (let ch = 0; ch < numChannels; ch++) {
        sum += wavBuf.readFloatLE(frameOffset + ch * 4);
      }
      const avg = sum / numChannels;
      const clamped = Number.isFinite(avg) ? Math.max(-1, Math.min(1, avg)) : 0;
      const intVal = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
      samples[i] = Math.max(-32768, Math.min(32767, intVal));
    }
    return { sampleRate, samples };
  }

  throw new Error(`Unsupported WAV format: audioFormat=${audioFormat}, bitsPerSample=${bitsPerSample}`);
}

/**
 * Computes duration, peak amplitude, active-frame RMS, and silence detection
 * (`peak < 150 && rms < 25` over active frames).
 */
export function computeWavStats(wavBuf: Buffer): WavStats {
  const { sampleRate, samples } = decodeMonoWavSamples(wavBuf);
  const numSamples = samples.length;
  if (numSamples === 0 || sampleRate <= 0) {
    return { durationMs: 0, rms: 0, peak: 0, isSilent: true };
  }

  const durationMs = Math.round((numSamples / sampleRate) * 1000);
  const frameLen = Math.max(1, Math.floor(sampleRate * 0.02)); // 20 ms frames

  let overallPeak = 0;
  let overallSumSq = 0;
  let activeSumSq = 0;
  let activeCount = 0;

  for (let start = 0; start < numSamples; start += frameLen) {
    const end = Math.min(numSamples, start + frameLen);
    let framePeak = 0;
    let frameSumSq = 0;

    for (let i = start; i < end; i++) {
      const s = samples[i];
      const abs = s < 0 ? -s : s;
      if (abs > framePeak) framePeak = abs;
      frameSumSq += s * s;
    }

    if (framePeak > overallPeak) overallPeak = framePeak;
    overallSumSq += frameSumSq;

    const count = end - start;
    const frameRms = Math.sqrt(frameSumSq / count);
    if (framePeak >= 150 || frameRms >= 25) {
      activeSumSq += frameSumSq;
      activeCount += count;
    }
  }

  const rms =
    activeCount > 0 ? Math.sqrt(activeSumSq / activeCount) : Math.sqrt(overallSumSq / numSamples);
  const isSilent = overallPeak < 150 && rms < 25;

  return {
    durationMs,
    rms: Math.round(rms * 100) / 100,
    peak: overallPeak,
    isSilent,
  };
}

/**
 * Returns true if at least 140 ms (7 x 20ms frames) meet or exceed the adaptive
 * noise-floor-gated RMS threshold after 90 Hz high-pass filtering.
 * Used to avoid sending silence or brief clicks (and dictionary hints) to ASR backends.
 */
export function hasActiveSpeechWav(
  wavBuf: Buffer,
  rmsThreshold = NOISY_SILENCE_RMS_THRESHOLD
): boolean {
  const { sampleRate, samples } = decodeMonoWavSamples(wavBuf);
  if (samples.length === 0 || sampleRate <= 0) return false;

  const { activeFlags } = analyzeSpeechFrames(samples, sampleRate, rmsThreshold);
  const minActiveFrames = Math.ceil(MIN_ACTIVE_SPEECH_MS / 20);
  let activeFrames = 0;
  for (let i = 0; i < activeFlags.length; i++) {
    if (activeFlags[i]) {
      activeFrames += 1;
      if (activeFrames >= minActiveFrames) return true;
    }
  }
  return false;
}

/**
 * Trims leading and trailing silence using adaptive 20ms frame-RMS gating (immune to clicks
 * and sub-90 Hz rumble) while preserving gentle speech onset/offset padding.
 */
export function trimSilenceWav(
  wavBuf: Buffer,
  keepHeadMs = 80,
  keepTailMs = 110,
  rmsThreshold = NOISY_SILENCE_RMS_THRESHOLD
): Buffer {
  const { sampleRate, samples } = decodeMonoWavSamples(wavBuf);
  const numSamples = samples.length;
  if (numSamples === 0 || sampleRate <= 0) return wavBuf;

  const frameLen = Math.max(1, Math.floor(sampleRate * 0.02)); // 20 ms frames
  const { activeFlags } = analyzeSpeechFrames(samples, sampleRate, rmsThreshold);
  const numFrames = activeFlags.length;

  let firstActiveFrame = 0;
  while (firstActiveFrame < numFrames && !activeFlags[firstActiveFrame]) {
    firstActiveFrame++;
  }
  if (firstActiveFrame >= numFrames) {
    return wavBuf;
  }

  let lastActiveFrame = numFrames - 1;
  while (lastActiveFrame > firstActiveFrame && !activeFlags[lastActiveFrame]) {
    lastActiveFrame--;
  }

  const firstActive = firstActiveFrame * frameLen;
  const lastActive = Math.min(numSamples - 1, (lastActiveFrame + 1) * frameLen - 1);

  const padBefore = Math.floor((sampleRate * keepHeadMs) / 1000);
  const padAfter = Math.floor((sampleRate * keepTailMs) / 1000);
  const startIdx = Math.max(0, firstActive - padBefore);
  const endIdx = Math.min(numSamples, lastActive + 1 + padAfter);

  return encodePcm16MonoWav(samples.subarray(startIdx, endIdx), sampleRate);
}

/**
 * Shortens internal silence runs longer than `minPauseMs` down to `targetPauseMs`,
 * applying a brief linear fade at splice boundaries to prevent clicks or pops.
 */
export function compactInternalSilenceWav(
  wavBuf: Buffer,
  options: CompactSilenceOptions = {}
): Buffer {
  const { sampleRate, samples } = decodeMonoWavSamples(wavBuf);
  const numSamples = samples.length;
  if (numSamples === 0 || sampleRate <= 0) return wavBuf;

  const rmsThreshold = options.rmsThreshold ?? NOISY_SILENCE_RMS_THRESHOLD;
  const minPauseMs = Math.max(0, options.minPauseMs ?? 800);
  const targetPauseMs = Math.max(0, Math.min(minPauseMs, options.targetPauseMs ?? 350));
  const fadeMs = Math.max(0, options.fadeMs ?? 10);

  const minPauseSamples = Math.floor((sampleRate * minPauseMs) / 1000);
  if (numSamples <= minPauseSamples) {
    return wavBuf;
  }

  const frameLen = Math.max(1, Math.floor(sampleRate * 0.02)); // 20 ms frames
  const { activeFlags } = analyzeSpeechFrames(samples, sampleRate, rmsThreshold);
  const numFrames = activeFlags.length;

  let firstActiveFrame = 0;
  while (firstActiveFrame < numFrames && !activeFlags[firstActiveFrame]) {
    firstActiveFrame++;
  }
  if (firstActiveFrame >= numFrames) {
    return wavBuf;
  }

  let lastActiveFrame = numFrames - 1;
  while (lastActiveFrame > firstActiveFrame && !activeFlags[lastActiveFrame]) {
    lastActiveFrame--;
  }

  const targetSamples = Math.round((sampleRate * targetPauseMs) / 1000);
  const requestedFadeSamples = Math.floor((sampleRate * fadeMs) / 1000);

  const segments: Array<{ start: number; end: number; fadeOut: number; fadeIn: number }> = [];
  let cursorSample = 0;
  let compactedAny = false;
  let f = firstActiveFrame;

  while (f <= lastActiveFrame) {
    if (activeFlags[f]) {
      f++;
      continue;
    }

    const runStartFrame = f;
    while (f <= lastActiveFrame && !activeFlags[f]) {
      f++;
    }
    const runEndFrame = f;

    const runStartSample = runStartFrame * frameLen;
    const runEndSample = Math.min(numSamples, runEndFrame * frameLen);
    const runSamples = runEndSample - runStartSample;
    const runDurationMs = (runSamples / sampleRate) * 1000;

    if (runDurationMs > minPauseMs && runSamples > targetSamples) {
      compactedAny = true;
      const leadKeep = Math.floor(targetSamples / 2);
      const tailKeep = targetSamples - leadKeep;
      const fadeSamples = Math.min(requestedFadeSamples, leadKeep, tailKeep);

      const leadEnd = runStartSample + leadKeep;
      if (leadEnd > cursorSample) {
        segments.push({
          start: cursorSample,
          end: leadEnd,
          fadeOut: fadeSamples,
          fadeIn: 0,
        });
      }

      const tailStart = runEndSample - tailKeep;
      if (tailStart < runEndSample) {
        segments.push({
          start: tailStart,
          end: runEndSample,
          fadeOut: 0,
          fadeIn: fadeSamples,
        });
      }
      cursorSample = runEndSample;
    }
  }

  if (!compactedAny) {
    return wavBuf;
  }

  if (cursorSample < numSamples) {
    segments.push({ start: cursorSample, end: numSamples, fadeOut: 0, fadeIn: 0 });
  }

  let totalOut = 0;
  for (const seg of segments) {
    totalOut += seg.end - seg.start;
  }

  const out = new Int16Array(totalOut);
  let writePos = 0;
  for (const seg of segments) {
    const segLen = seg.end - seg.start;
    out.set(samples.subarray(seg.start, seg.end), writePos);

    if (seg.fadeOut > 0) {
      const fadeStart = writePos + segLen - seg.fadeOut;
      for (let k = 0; k < seg.fadeOut; k++) {
        const gain = (seg.fadeOut - 1 - k) / seg.fadeOut;
        out[fadeStart + k] = Math.round(out[fadeStart + k] * gain);
      }
    }

    if (seg.fadeIn > 0) {
      for (let k = 0; k < seg.fadeIn; k++) {
        const gain = k / seg.fadeIn;
        out[writePos + k] = Math.round(out[writePos + k] * gain);
      }
    }

    writePos += segLen;
  }

  return encodePcm16MonoWav(out, sampleRate);
}

/**
 * Splits audio longer than `maxChunkSec` at the lowest-energy 150 ms valley
 * between `minChunkSec` and `maxChunkSec` recursively, with `overlapMs` overlap
 * so words at chunk boundaries are not chopped.
 */
export function splitWavIntoChunks(
  wavBuf: Buffer,
  maxChunkSec = DEFAULT_MAX_CHUNK_SEC,
  minChunkSec = DEFAULT_MIN_CHUNK_SEC,
  overlapMs = 380
): Buffer[] {
  const { sampleRate, samples } = decodeMonoWavSamples(wavBuf);
  if (samples.length === 0 || sampleRate <= 0) {
    return [wavBuf];
  }

  const maxSamples = Math.floor(maxChunkSec * sampleRate);
  if (samples.length <= maxSamples) {
    return [wavBuf];
  }

  const minSamples = Math.max(1, Math.min(maxSamples - 1, Math.floor(minChunkSec * sampleRate)));
  const searchEnd = Math.min(samples.length, maxSamples);
  const windowSamples = Math.max(1, Math.min(Math.floor(0.15 * sampleRate), searchEnd - minSamples));

  let splitIdx = searchEnd;

  if (searchEnd - minSamples > windowSamples) {
    let windowSumSq = 0;
    for (let i = minSamples; i < minSamples + windowSamples; i++) {
      const s = samples[i];
      windowSumSq += s * s;
    }

    let bestSumSq = windowSumSq;
    let bestStart = minSamples;

    const lastWindowStart = searchEnd - windowSamples;
    for (let start = minSamples + 1; start <= lastWindowStart; start++) {
      const leaving = samples[start - 1];
      const entering = samples[start + windowSamples - 1];
      windowSumSq += entering * entering - leaving * leaving;
      if (windowSumSq < bestSumSq) {
        bestSumSq = windowSumSq;
        bestStart = start;
      }
    }

    splitIdx = bestStart + Math.floor(windowSamples / 2);
  }

  if (splitIdx <= 0 || splitIdx >= samples.length) {
    splitIdx = Math.min(maxSamples, samples.length - 1);
  }

  const overlapSamples = Math.max(0, Math.floor((sampleRate * overlapMs) / 1000));
  const tailStart = splitIdx > overlapSamples ? splitIdx - overlapSamples : splitIdx;

  const head = encodePcm16MonoWav(samples.subarray(0, splitIdx), sampleRate);
  const tail = encodePcm16MonoWav(samples.subarray(tailStart), sampleRate);
  return [head, ...splitWavIntoChunks(tail, maxChunkSec, minChunkSec, overlapMs)];
}
