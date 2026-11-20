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
  computeGentleWhisperGain,
  createAudioConstraints,
  resampleFloat32,
  PRE_ROLL_MS,
  TAIL_DRAIN_MS,
  WHISPER_MAX_GAIN,
  WHISPER_PEAK_THRESHOLD,
  WHISPER_TARGET_PEAK,
} = await import('../src/renderer/hud/micCapture');

test('createDefaultSettings sets whisperModeBoost to false and micProfile to quiet', () => {
  assert.equal(createDefaultSettings('win32').whisperModeBoost, false);
  assert.equal(createDefaultSettings('linux').whisperModeBoost, false);
  assert.equal(createDefaultSettings('win32').micProfile, 'quiet');
  assert.equal(createDefaultSettings('linux').micProfile, 'quiet');
});

test('createAudioConstraints configures echoCancellation/noiseSuppression by micProfile', () => {
  const quiet = createAudioConstraints('default', 'quiet');
  assert.deepEqual(quiet, {
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: true,
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

test('computeGentleWhisperGain only boosts genuinely quiet non-zero audio', () => {
  assert.equal(computeGentleWhisperGain(0.05, false), 1);
  assert.equal(computeGentleWhisperGain(0, true), 1);
  assert.equal(computeGentleWhisperGain(WHISPER_PEAK_THRESHOLD, true), 1);
  assert.equal(computeGentleWhisperGain(0.4, true), 1);

  // Quiet audio (0.10) is normalized toward WHISPER_TARGET_PEAK (0.50 -> 5x)
  assert.ok(Math.abs(computeGentleWhisperGain(0.1, true) - WHISPER_TARGET_PEAK / 0.1) < 1e-6);

  // Ultra-quiet noise floor is capped at WHISPER_MAX_GAIN
  assert.equal(computeGentleWhisperGain(0.001, true), WHISPER_MAX_GAIN);
});

test('resampleFloat32 computes speechDurationMs before whisper boost and avoids clipping normal speech', () => {
  const sr = 16000;
  // 100ms of quiet noise (RMS ~0.008 < SPEECH_RMS_THRESHOLD 0.014, peak = 0.008 < 0.15)
  const quiet = new Float32Array(sr * 0.1).fill(0.008);
  const quietRes = resampleFloat32([quiet], sr, sr, true);
  assert.equal(quietRes.speechDurationMs, 0);
  assert.ok(Math.abs(quietRes.peak - 0.008 * WHISPER_MAX_GAIN) < 1e-5);

  // Normal speech (peak = 0.4 >= 0.15) should not be boosted or distorted
  const normal = new Float32Array(sr * 0.1).fill(0.4);
  const normalRes = resampleFloat32([normal], sr, sr, true);
  assert.equal(normalRes.speechDurationMs, 100);
  assert.ok(Math.abs(normalRes.peak - 0.4) < 1e-6);
  assert.ok(Math.abs(normalRes.pcm[0] - 0.4) < 1e-6);

  // Quiet speech (peak = 0.10, RMS = 0.10 >= 0.014) gets gentle linear boost to 0.50
  const softSpeech = new Float32Array(sr * 0.1).fill(0.1);
  const softRes = resampleFloat32([softSpeech], sr, sr, true);
  assert.equal(softRes.speechDurationMs, 100);
  assert.ok(Math.abs(softRes.peak - 0.5) < 1e-5);
  assert.ok(Math.abs(softRes.pcm[0] - 0.5) < 1e-5);
});
