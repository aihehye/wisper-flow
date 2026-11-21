import fs from 'node:fs';
import module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Allow Node's --experimental-strip-types loader to resolve @shared/* and extensionless relative TS imports.
module.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@shared/')) {
      const candidate = path.resolve(repoRoot, 'src', 'shared', `${specifier.slice('@shared/'.length)}.ts`);
      if (fs.existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      !path.extname(specifier) &&
      context.parentURL
    ) {
      const parentPath = fileURLToPath(context.parentURL);
      const candidate = path.resolve(path.dirname(parentPath), `${specifier}.ts`);
      if (fs.existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

const { createDefaultSettings } = await import('../src/shared/defaults');
const {
  RollingPreRollBuffer,
  computeActiveSpeechRms,
  computeActiveSpeechWhisperGain,
  computeWhisperGainFromRms,
  createAudioConstraints,
  resampleFloat32,
  softLimitSample,
  PRE_ROLL_MS,
  SOFT_LIMITER_CEILING,
  SOFT_LIMITER_THRESHOLD,
  TAIL_DRAIN_MS,
  WHISPER_MAX_GAIN,
  WHISPER_TARGET_RMS,
} = await import('../src/renderer/hud/micCapture');

test('createDefaultSettings sets whisperModeBoost to false and micProfile to quiet', () => {
  assert.equal(createDefaultSettings('win32').whisperModeBoost, false);
  assert.equal(createDefaultSettings('linux').whisperModeBoost, false);
  assert.equal(createDefaultSettings('win32').micProfile, 'quiet');
  assert.equal(createDefaultSettings('linux').micProfile, 'quiet');
});

test('createAudioConstraints configures WebRTC DSP flags by micProfile', () => {
  const quiet = createAudioConstraints('default', 'quiet');
  assert.deepEqual(quiet, {
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    video: false,
  });

  const noisy = createAudioConstraints('usb-mic-1', 'noisy');
  assert.deepEqual(noisy, {
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      deviceId: { exact: 'usb-mic-1' },
    },
    video: false,
  });
});

test('PRE_ROLL_MS and TAIL_DRAIN_MS are within expected ranges', () => {
  assert.ok(PRE_ROLL_MS >= 200 && PRE_ROLL_MS <= 300);
  assert.ok(TAIL_DRAIN_MS >= 120 && TAIL_DRAIN_MS <= 200);
});

test('RollingPreRollBuffer keeps only the most recent maxSamples and drains cleanly', () => {
  const buf = new RollingPreRollBuffer(5);
  buf.push(new Float32Array([1, 2, 3]));
  buf.push(new Float32Array([4, 5, 6, 7]));

  assert.equal(buf.totalSamples, 5);
  const drained = buf.drain();
  const merged = drained.flatMap((c) => Array.from(c));
  assert.deepEqual(merged, [3, 4, 5, 6, 7]);
  assert.equal(buf.totalSamples, 0);
  assert.deepEqual(buf.drain(), []);
});

test('RollingPreRollBuffer handles single chunk larger than maxSamples and clear()', () => {
  const buf = new RollingPreRollBuffer(4);
  buf.push(new Float32Array([10, 20, 30, 40, 50, 60]));
  assert.equal(buf.totalSamples, 4);
  assert.deepEqual(Array.from(buf.drain()[0]), [30, 40, 50, 60]);

  buf.push(new Float32Array([1, 2]));
  buf.clear();
  assert.equal(buf.totalSamples, 0);
  assert.deepEqual(buf.drain(), []);
});

test('computeWhisperGainFromRms targets -20 dBFS RMS with [1.0, 8.0] bounds', () => {
  assert.equal(WHISPER_TARGET_RMS, 0.1);
  assert.equal(WHISPER_MAX_GAIN, 8.0);
  assert.equal(computeWhisperGainFromRms(0.02, false), 1);
  assert.equal(computeWhisperGainFromRms(0, true), 1);
  assert.equal(computeWhisperGainFromRms(WHISPER_TARGET_RMS, true), 1);
  assert.equal(computeWhisperGainFromRms(0.25, true), 1);

  // Quiet speech at 0.02 RMS -> 5x boost to reach 0.10 (-20 dBFS)
  assert.ok(Math.abs(computeWhisperGainFromRms(0.02, true) - 5.0) < 1e-6);

  // Ultra-quiet speech is capped at WHISPER_MAX_GAIN (8.0x)
  assert.equal(computeWhisperGainFromRms(0.005, true), WHISPER_MAX_GAIN);
});

test('softLimitSample passes signals <= 0.75 linearly and soft-limits peaks <= 0.95', () => {
  assert.equal(softLimitSample(0), 0);
  assert.equal(softLimitSample(0.5), 0.5);
  assert.equal(softLimitSample(-0.75), -0.75);

  const posPeak = softLimitSample(1.0);
  const negPeak = softLimitSample(-1.0);
  assert.ok(posPeak > SOFT_LIMITER_THRESHOLD && posPeak <= SOFT_LIMITER_CEILING);
  assert.ok(negPeak < -SOFT_LIMITER_THRESHOLD && negPeak >= -SOFT_LIMITER_CEILING);

  // Extreme transients still never exceed 0.95 ceiling
  assert.ok(softLimitSample(8.0) <= SOFT_LIMITER_CEILING);
  assert.ok(softLimitSample(-8.0) >= -SOFT_LIMITER_CEILING);
});

test('single 1.0 peak click does NOT kill whisper boost and gets soft-limited <= 0.95', () => {
  const sr = 16000;
  // 400ms of leading silence + 400ms of quiet whisper (0.02 RMS) with a single 1.0 click sample
  const samples = new Float32Array(Math.round(sr * 0.8));
  const speechStart = Math.round(sr * 0.4);
  for (let i = speechStart; i < samples.length; i += 1) {
    // 300 Hz sine with peak 0.0283 -> RMS ~0.02
    samples[i] = 0.028284 * Math.sin((2 * Math.PI * 300 * i) / sr);
  }
  samples[speechStart + 100] = 1.0; // Single-sample 1.0 click!

  const activeRms = computeActiveSpeechRms(samples, sr);
  assert.ok(activeRms > 0.018 && activeRms < 0.025, `Expected ~0.02 active RMS, got ${activeRms}`);

  const gain = computeActiveSpeechWhisperGain(samples, sr, true);
  assert.ok(gain > 4.0 && gain <= 5.5, `Expected ~5x gain despite 1.0 click, got ${gain}`);

  const res = resampleFloat32([samples], sr, sr, true);
  assert.ok(res.peak <= SOFT_LIMITER_CEILING, `Expected peak <= 0.95, got ${res.peak}`);
  for (let i = 0; i < res.pcm.length; i += 1) {
    assert.ok(Math.abs(res.pcm[i]) <= SOFT_LIMITER_CEILING);
  }
});

test('resampleFloat32 computes speechDurationMs before whisper boost and avoids clipping normal speech', () => {
  const sr = 16000;
  // 100ms of quiet audio (RMS 0.008 < SPEECH_RMS_THRESHOLD 0.014, >= WHISPER_ACTIVITY_RMS_FLOOR 0.0015)
  const quiet = new Float32Array(sr * 0.1).fill(0.008);
  const quietRes = resampleFloat32([quiet], sr, sr, true);
  assert.equal(quietRes.speechDurationMs, 0);
  assert.ok(Math.abs(quietRes.peak - 0.008 * WHISPER_MAX_GAIN) < 1e-5);

  // Normal speech (RMS 0.2 >= WHISPER_TARGET_RMS 0.10) should not be boosted or distorted
  const normal = new Float32Array(sr * 0.1).fill(0.2);
  const normalRes = resampleFloat32([normal], sr, sr, true);
  assert.equal(normalRes.speechDurationMs, 100);
  assert.ok(Math.abs(normalRes.peak - 0.2) < 1e-6);
  assert.ok(Math.abs(normalRes.pcm[0] - 0.2) < 1e-6);

  // Quiet speech (RMS 0.02 >= 0.014) gets 5x RMS boost to 0.10 (-20 dBFS)
  const softSpeech = new Float32Array(sr * 0.1).fill(0.02);
  const softRes = resampleFloat32([softSpeech], sr, sr, true);
  assert.equal(softRes.speechDurationMs, 100);
  assert.ok(Math.abs(softRes.peak - 0.1) < 1e-5);
  assert.ok(Math.abs(softRes.pcm[0] - 0.1) < 1e-5);

  // Pure silence / sub-floor hum (< 0.0015) is not boosted
  const silence = new Float32Array(sr * 0.1).fill(0.0005);
  const silenceRes = resampleFloat32([silence], sr, sr, true);
  assert.equal(silenceRes.speechDurationMs, 0);
  assert.ok(Math.abs(silenceRes.peak - 0.0005) < 1e-6);
});
