import fs from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Allow Node's --experimental-strip-types loader to resolve extensionless relative TS imports.
module.registerHooks({
  resolve(specifier, context, nextResolve) {
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

const {
  encodePcm16MonoWav,
  decodeMonoWavSamples,
  computeWavStats,
  trimSilenceWav,
  hasActiveSpeechWav,
  compactInternalSilenceWav,
  splitWavIntoChunks,
  getSilenceRmsThreshold,
  applyHighPassFilter,
  applyHighPassWav,
  applySpeechEqWav,
  preprocessSpeechWav,
  computeAdaptiveRmsThreshold,
  QUIET_SILENCE_RMS_THRESHOLD,
  NOISY_SILENCE_RMS_THRESHOLD,
  DEFAULT_MAX_CHUNK_SEC,
  DEFAULT_MIN_CHUNK_SEC,
} = await import('../src/main/asr/wavUtils');
const {
  parseDeviceListOutput,
  pickBestGpuDevice,
  cleanRumbleOutput,
  joinChunkTranscripts,
} = await import('../src/main/asr/llamaServerBackend');
const { SoundResolver } = await import('../src/main/sounds/soundResolver');

function makeSineSamples(
  sampleRate: number,
  durationSec: number,
  freqHz = 440,
  amplitude = 10000
): Int16Array {
  const count = Math.floor(sampleRate * durationSec);
  const out = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate));
  }
  return out;
}

test('encodePcm16MonoWav and decodeMonoWavSamples round-trip Int16Array and Float32Array', () => {
  const sr = 16000;
  const input = makeSineSamples(sr, 0.25, 440, 12000);
  const wav = encodePcm16MonoWav(input, sr);

  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');

  const decoded = decodeMonoWavSamples(wav);
  assert.equal(decoded.sampleRate, sr);
  assert.equal(decoded.samples.length, input.length);
  for (let i = 0; i < input.length; i++) {
    assert.equal(decoded.samples[i], input[i]);
  }

  // Float32Array encoding check
  const f32 = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const wavF32 = encodePcm16MonoWav(f32, sr);
  const decodedF32 = decodeMonoWavSamples(wavF32);
  assert.equal(decodedF32.samples[0], 0);
  assert.ok(Math.abs(decodedF32.samples[1] - 16384) <= 2);
  assert.ok(Math.abs(decodedF32.samples[2] + 16384) <= 2);
  assert.equal(decodedF32.samples[3], 32767);
  assert.equal(decodedF32.samples[4], -32768);
});

test('computeWavStats detects silent vs active audio', () => {
  const silent = encodePcm16MonoWav(new Int16Array(16000), 16000);
  const silentStats = computeWavStats(silent);
  assert.equal(silentStats.durationMs, 1000);
  assert.equal(silentStats.peak, 0);
  assert.equal(silentStats.rms, 0);
  assert.equal(silentStats.isSilent, true);

  const tone = encodePcm16MonoWav(makeSineSamples(16000, 1, 440, 8000), 16000);
  const toneStats = computeWavStats(tone);
  assert.equal(toneStats.durationMs, 1000);
  assert.ok(toneStats.peak >= 7990);
  assert.ok(toneStats.rms > 5000);
  assert.equal(toneStats.isSilent, false);
});

test('trimSilenceWav trims long silent head and tail while keeping active sine tone intact', () => {
  const sr = 16000;
  const headSilence = new Int16Array(sr * 2); // 2.0s silence
  const tone = makeSineSamples(sr, 1.0, 440, 9000); // 1.0s active tone
  const tailSilence = new Int16Array(sr * 2); // 2.0s silence

  const combined = new Int16Array(headSilence.length + tone.length + tailSilence.length);
  combined.set(headSilence, 0);
  combined.set(tone, headSilence.length);
  combined.set(tailSilence, headSilence.length + tone.length);

  const rawWav = encodePcm16MonoWav(combined, sr);
  const trimmedWav = trimSilenceWav(rawWav, 80, 110);
  const decoded = decodeMonoWavSamples(trimmedWav);

  const trimmedDurationMs = (decoded.samples.length / decoded.sampleRate) * 1000;
  // ~1000 ms tone + ~80 ms head + ~110 ms tail = ~1190 ms (way shorter than 5000 ms)
  assert.ok(trimmedDurationMs >= 1150 && trimmedDurationMs <= 1250, `Expected ~1190ms, got ${trimmedDurationMs}`);

  // Confirm active tone energy is preserved
  const stats = computeWavStats(trimmedWav);
  assert.equal(stats.isSilent, false);
  assert.ok(stats.peak >= 8900);
});

test('splitWavIntoChunks keeps 10s WAV intact and splits 35s WAV at quiet valley into <= 28s chunks', () => {
  const sr = 16000;

  // 10s WAV -> single chunk
  const shortWav = encodePcm16MonoWav(makeSineSamples(sr, 10, 440, 5000), sr);
  const shortChunks = splitWavIntoChunks(shortWav, 28, 16);
  assert.equal(shortChunks.length, 1);

  // 35s WAV with a 0.5s quiet valley centered at 20.0s (between 16s and 28s)
  const samples = makeSineSamples(sr, 35, 440, 8000);
  const valleyStart = Math.floor(19.75 * sr);
  const valleyEnd = Math.floor(20.25 * sr);
  for (let i = valleyStart; i < valleyEnd; i++) {
    samples[i] = 0;
  }

  const longWav = encodePcm16MonoWav(samples, sr);
  const chunks = splitWavIntoChunks(longWav, 28, 16);

  assert.ok(chunks.length >= 2, `Expected >= 2 chunks, got ${chunks.length}`);
  for (const chunk of chunks) {
    const decoded = decodeMonoWavSamples(chunk);
    const durSec = decoded.samples.length / decoded.sampleRate;
    assert.ok(durSec <= 28, `Chunk exceeded 28s: ${durSec}s`);
  }

  // First chunk should split right around 20s (within the [19.75s, 20.25s] valley)
  const firstDurSec = decodeMonoWavSamples(chunks[0]).samples.length / sr;
  assert.ok(firstDurSec >= 19.7 && firstDurSec <= 20.3, `Expected split near 20s valley, got ${firstDurSec}s`);

  // Verify ~380ms overlap between chunk 0 and chunk 1
  const totalChunkSamples = chunks.reduce((acc, c) => acc + decodeMonoWavSamples(c).samples.length, 0);
  const expectedOverlap = Math.floor((sr * 380) / 1000);
  assert.equal(totalChunkSamples, samples.length + expectedOverlap);
});

test('trimSilenceWav ignores isolated single-sample clicks via 20ms frame-RMS gating', () => {
  const sr = 16000;
  const headSilence = new Int16Array(sr * 2);
  headSilence[800] = 1500; // isolated single-sample click in silence
  const tone = makeSineSamples(sr, 1.0, 440, 9000);
  const tailSilence = new Int16Array(sr * 2);
  tailSilence[sr * 2 - 500] = -1500; // isolated single-sample click in tail silence

  const combined = new Int16Array(headSilence.length + tone.length + tailSilence.length);
  combined.set(headSilence, 0);
  combined.set(tone, headSilence.length);
  combined.set(tailSilence, headSilence.length + tone.length);

  const rawWav = encodePcm16MonoWav(combined, sr);
  const trimmedWav = trimSilenceWav(rawWav, 80, 110);
  const decoded = decodeMonoWavSamples(trimmedWav);
  const trimmedDurationMs = (decoded.samples.length / decoded.sampleRate) * 1000;

  assert.ok(trimmedDurationMs >= 1150 && trimmedDurationMs <= 1250, `Expected ~1190ms, got ${trimmedDurationMs}`);
});

test('joinChunkTranscripts deduplicates overlapping boundary words across chunks', () => {
  assert.equal(
    joinChunkTranscripts(['Hello world how are', 'how are you doing today']),
    'Hello world how are you doing today'
  );
  assert.equal(
    joinChunkTranscripts(['Something that works for.', 'For Linux tool and more']),
    'Something that works for. Linux tool and more'
  );
  assert.equal(
    joinChunkTranscripts(['First chunk.', '', 'Second chunk.']),
    'First chunk. Second chunk.'
  );
});

test('parseDeviceListOutput and pickBestGpuDevice select discrete NVIDIA over Intel iGPU', () => {
  const sampleOutput = [
    'ggml_vulkan: Found 2 Vulkan devices:',
    '  Vulkan0: Intel(R) Graphics',
    '  Vulkan1: NVIDIA GeForce RTX 4050 Laptop GPU',
    '  CPU: 13th Gen Intel(R) Core(TM) i7',
  ].join('\n');

  const devices = parseDeviceListOutput(sampleOutput);
  assert.equal(devices.length, 3);
  assert.equal(devices[0].id, 'Vulkan0');
  assert.equal(devices[0].vendor, 'intel');
  assert.equal(devices[0].isDiscrete, false);

  assert.equal(devices[1].id, 'Vulkan1');
  assert.equal(devices[1].vendor, 'nvidia');
  assert.equal(devices[1].isDiscrete, true);

  assert.equal(devices[2].id, 'CPU');
  assert.equal(devices[2].vendor, 'cpu');
  assert.equal(devices[2].isDiscrete, false);

  const bestAuto = pickBestGpuDevice(devices, 'auto');
  assert.equal(bestAuto?.id, 'Vulkan1');

  const explicit = pickBestGpuDevice(devices, 'Vulkan0');
  assert.equal(explicit?.id, 'Vulkan0');
});

test('cleanRumbleOutput strips language prefix and <asr_text> tag cleanly', () => {
  assert.deepEqual(cleanRumbleOutput('language English<asr_text>Hello world.'), {
    text: 'Hello world.',
    detectedLanguage: 'English',
  });

  assert.deepEqual(cleanRumbleOutput('  <asr_text>"Testing quotes."  '), {
    text: 'Testing quotes.',
  });

  assert.deepEqual(cleanRumbleOutput('Plain transcription without tags'), {
    text: 'Plain transcription without tags',
  });
});

test('SoundResolver resolves bundled and custom sound slots to data URLs', () => {
  const bundledDir = path.resolve(process.cwd(), 'assets', 'sounds');
  const tmpCustom = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-sounds-'));
  try {
    const v12Dir = path.join(tmpCustom, 'v12');
    fs.mkdirSync(v12Dir, { recursive: true });
    const fakeWav = encodePcm16MonoWav(new Int16Array(160), 16000);
    fs.writeFileSync(path.join(v12Dir, 'dictation-start.wav'), fakeWav);

    const resolver = new SoundResolver(bundledDir, tmpCustom);
    const statuses = resolver.listStatuses(tmpCustom);
    assert.equal(statuses.length, 8);

    const startSlot = statuses.find((s) => s.slot === 'start');
    assert.equal(startSlot?.source, 'custom');
    assert.equal(startSlot?.fileName, 'v12/dictation-start.wav');

    const stopSlot = statuses.find((s) => s.slot === 'stop');
    assert.equal(stopSlot?.source, 'bundled');

    const dataUrl = resolver.getSlotDataUrl('start', tmpCustom);
    assert.ok(dataUrl?.startsWith('data:audio/wav;base64,'));
  } finally {
    fs.rmSync(tmpCustom, { recursive: true, force: true });
  }
});

test('getSilenceRmsThreshold and trimSilenceWav preserve soft whispers in quiet mode', () => {
  assert.equal(getSilenceRmsThreshold('quiet'), QUIET_SILENCE_RMS_THRESHOLD);
  assert.equal(getSilenceRmsThreshold('noisy'), NOISY_SILENCE_RMS_THRESHOLD);

  const sr = 16000;
  const head = new Int16Array(sr * 1);
  // Soft whisper sine (amplitude 120 -> RMS ~85: >= 50 quiet threshold, < 120 noisy threshold)
  const softWhisper = makeSineSamples(sr, 0.8, 300, 120);
  const tail = new Int16Array(sr * 1);
  const combined = new Int16Array(head.length + softWhisper.length + tail.length);
  combined.set(head, 0);
  combined.set(softWhisper, head.length);
  combined.set(tail, head.length + softWhisper.length);

  const rawWav = encodePcm16MonoWav(combined, sr);
  const quietTrimmed = trimSilenceWav(rawWav, 80, 110, QUIET_SILENCE_RMS_THRESHOLD);
  const quietDurMs = (decodeMonoWavSamples(quietTrimmed).samples.length / sr) * 1000;
  assert.ok(quietDurMs >= 940 && quietDurMs <= 1050, `Expected ~990ms, got ${quietDurMs}`);

  // With noisy threshold (120), the 85 RMS whisper isn't detected as active so buffer is unchanged
  const noisyTrimmed = trimSilenceWav(rawWav, 80, 110, NOISY_SILENCE_RMS_THRESHOLD);
  assert.equal(decodeMonoWavSamples(noisyTrimmed).samples.length, combined.length);
});

test('compactInternalSilenceWav compacts pauses > 800ms to 350ms with splice fade and leaves short pauses untouched', () => {
  const sr = 16000;

  // Short pause (500ms < 800ms) -> passes through completely untouched
  const s1 = makeSineSamples(sr, 0.6, 440, 6000);
  const shortPause = new Int16Array(Math.floor(sr * 0.5));
  const s2 = makeSineSamples(sr, 0.6, 520, 6000);
  const noLongPause = new Int16Array(s1.length + shortPause.length + s2.length);
  noLongPause.set(s1, 0);
  noLongPause.set(shortPause, s1.length);
  noLongPause.set(s2, s1.length + shortPause.length);
  const noLongPauseWav = encodePcm16MonoWav(noLongPause, sr);
  assert.equal(compactInternalSilenceWav(noLongPauseWav), noLongPauseWav);

  // Very short clip (< 800ms total) -> untouched
  const shortClipWav = encodePcm16MonoWav(makeSineSamples(sr, 0.4, 440, 6000), sr);
  assert.equal(compactInternalSilenceWav(shortClipWav), shortClipWav);

  // Long internal pause (2.4s) with small DC/floor (20 < 50) -> compacted to 350ms with 10ms fade to 0 at splice
  const longPause = new Int16Array(Math.floor(sr * 2.4)).fill(20);
  const withLongPause = new Int16Array(s1.length + longPause.length + s2.length);
  withLongPause.set(s1, 0);
  withLongPause.set(longPause, s1.length);
  withLongPause.set(s2, s1.length + longPause.length);

  const compactedWav = compactInternalSilenceWav(encodePcm16MonoWav(withLongPause, sr), {
    rmsThreshold: QUIET_SILENCE_RMS_THRESHOLD,
  });
  const decoded = decodeMonoWavSamples(compactedWav);
  const targetPauseSamples = Math.round(sr * 0.35);
  const expectedMinSamples = s1.length + s2.length + targetPauseSamples;
  // 90 Hz HPF step response from abrupt s1 cutoff may retain at most 1 boundary frame (320 samples)
  assert.ok(
    decoded.samples.length >= expectedMinSamples && decoded.samples.length <= expectedMinSamples + 320,
    `Expected compacted length within [${expectedMinSamples}, ${expectedMinSamples + 320}], got ${decoded.samples.length}`
  );

  // Verify splice boundary fades smoothly through 0
  const retainedPrefix = decoded.samples.length - s2.length - Math.ceil(targetPauseSamples / 2);
  assert.equal(decoded.samples[retainedPrefix - 1], 0);
  assert.equal(decoded.samples[retainedPrefix], 0);
  // Before fade-out region (earlier in lead pause), floor value 20 is intact
  assert.equal(decoded.samples[s1.length + 10], 20);
});

test('splitWavIntoChunks defaults to 90s max / 45s min and splits 110s WAV cleanly', () => {
  assert.equal(DEFAULT_MAX_CHUNK_SEC, 90);
  assert.equal(DEFAULT_MIN_CHUNK_SEC, 45);

  const sr = 16000;
  // 60s WAV stays a single chunk under default 90s cap
  const sixtySecWav = encodePcm16MonoWav(makeSineSamples(sr, 60, 440, 4000), sr);
  const singleChunks = splitWavIntoChunks(sixtySecWav);
  assert.equal(singleChunks.length, 1);

  // 110s WAV with a 0.5s quiet valley at 60s (within [45s, 90s]) splits into 2 chunks <= 90s
  const longSamples = makeSineSamples(sr, 110, 440, 4000);
  const valleyStart = Math.floor(59.75 * sr);
  const valleyEnd = Math.floor(60.25 * sr);
  for (let i = valleyStart; i < valleyEnd; i++) {
    longSamples[i] = 0;
  }

  const chunks = splitWavIntoChunks(encodePcm16MonoWav(longSamples, sr));
  assert.equal(chunks.length, 2);
  for (const chunk of chunks) {
    const durSec = decodeMonoWavSamples(chunk).samples.length / sr;
    assert.ok(durSec <= 90, `Chunk exceeded 90s: ${durSec}s`);
  }
  const firstDurSec = decodeMonoWavSamples(chunks[0]).samples.length / sr;
  assert.ok(firstDurSec >= 59.7 && firstDurSec <= 60.3, `Expected split near 60s, got ${firstDurSec}s`);
});

test('hasActiveSpeechWav requires >= 140ms active frames and ignores short clicks', () => {
  const sr = 16000;
  const silent = encodePcm16MonoWav(new Int16Array(sr), sr);
  assert.equal(hasActiveSpeechWav(silent, QUIET_SILENCE_RMS_THRESHOLD), false);

  // Brief 40ms click/burst (< 140ms) should return false
  const clickBurst = new Int16Array(sr);
  const burst = makeSineSamples(sr, 0.04, 440, 2000);
  clickBurst.set(burst, Math.floor(sr * 0.2));
  assert.equal(hasActiveSpeechWav(encodePcm16MonoWav(clickBurst, sr), QUIET_SILENCE_RMS_THRESHOLD), false);

  // Real speech (>= 140ms) with quiet pre-roll silence returns true
  const speech = new Int16Array(sr);
  const tone = makeSineSamples(sr, 0.5, 440, 200);
  speech.set(tone, Math.floor(sr * 0.25));
  assert.equal(hasActiveSpeechWav(encodePcm16MonoWav(speech, sr), QUIET_SILENCE_RMS_THRESHOLD), true);
});

test('computeAdaptiveRmsThreshold adapts to elevated noise floor while ignoring sub-90Hz rumble', () => {
  const sr = 16000;

  // Sub-90 Hz rumble (40 Hz) should be attenuated by 90 Hz HPF and not inflate threshold or trigger VAD
  const rumble = makeSineSamples(sr, 1.0, 40, 2000);
  const rumbleThreshold = computeAdaptiveRmsThreshold(rumble, sr, QUIET_SILENCE_RMS_THRESHOLD);
  assert.ok(rumbleThreshold < 600, `Expected low threshold after 90Hz HPF, got ${rumbleThreshold}`);
  assert.equal(hasActiveSpeechWav(encodePcm16MonoWav(rumble, sr), QUIET_SILENCE_RMS_THRESHOLD), false);

  // Elevated 500 Hz noise floor (~400 amplitude -> ~283 RMS) raises threshold to ~2.2x noiseFloor
  const noisyFloor = makeSineSamples(sr, 1.0, 500, 400);
  const adaptive = computeAdaptiveRmsThreshold(noisyFloor, sr, QUIET_SILENCE_RMS_THRESHOLD);
  assert.ok(adaptive >= 550 && adaptive <= 700, `Expected ~620 adaptive threshold, got ${adaptive}`);
  // Steady noise floor alone does not falsely trigger active speech
  assert.equal(hasActiveSpeechWav(encodePcm16MonoWav(noisyFloor, sr), QUIET_SILENCE_RMS_THRESHOLD), false);

  // Adding speech at 1500 amplitude (~1060 RMS > ~620 adaptive threshold) triggers active speech
  const speech = makeSineSamples(sr, 0.4, 500, 1500);
  const noisyWithSpeech = new Int16Array(noisyFloor);
  noisyWithSpeech.set(speech, Math.floor(sr * 0.3));
  assert.equal(hasActiveSpeechWav(encodePcm16MonoWav(noisyWithSpeech, sr), QUIET_SILENCE_RMS_THRESHOLD), true);

  // High noise floor is capped at 1800
  const veryNoisy = makeSineSamples(sr, 0.5, 500, 5000);
  assert.equal(computeAdaptiveRmsThreshold(veryNoisy, sr, QUIET_SILENCE_RMS_THRESHOLD), 1800);
});

test('applyHighPassFilter and preprocessSpeechWav attenuate bass rumble, boost consonants, and prevent int16 wrap', () => {
  const sr = 16000;

  // 40 Hz rumble is strongly attenuated by 90 Hz HPF
  const rumble = makeSineSamples(sr, 0.5, 40, 8000);
  const hpRumble = applyHighPassFilter(rumble, sr, 90);
  const rumbleStats = computeWavStats(encodePcm16MonoWav(hpRumble.subarray(Math.floor(sr * 0.1)), sr));
  assert.ok(rumbleStats.rms < 1500, `Expected 40Hz rumble attenuated, got rms=${rumbleStats.rms}`);

  // Compare steady-state RMS of 150 Hz (low shelf -4dB + HPF) vs 3000 Hz (high shelf +8dB)
  const lowTone = encodePcm16MonoWav(makeSineSamples(sr, 0.5, 150, 4000), sr);
  const highTone = encodePcm16MonoWav(makeSineSamples(sr, 0.5, 3000, 4000), sr);
  const lowOut = decodeMonoWavSamples(preprocessSpeechWav(lowTone)).samples;
  const highOut = decodeMonoWavSamples(preprocessSpeechWav(highTone)).samples;

  const steadyStart = Math.floor(sr * 0.15);
  const lowOutStats = computeWavStats(encodePcm16MonoWav(lowOut.subarray(steadyStart), sr));
  const highOutStats = computeWavStats(encodePcm16MonoWav(highOut.subarray(steadyStart), sr));

  // 4000 sine RMS is ~2828; 150 Hz should be attenuated (~-4 dB -> < 2000), 3000 Hz boosted (~+8 dB -> > 5500)
  assert.ok(lowOutStats.rms < 2000, `Expected 150 Hz attenuation, got rms=${lowOutStats.rms}`);
  assert.ok(highOutStats.rms > 5500, `Expected 3000 Hz boost, got rms=${highOutStats.rms}`);

  // High-amplitude 3000 Hz signal must soft-saturate without wrapping negative/positive
  const loudHigh = encodePcm16MonoWav(makeSineSamples(sr, 0.2, 3000, 28000), sr);
  const loudEq = decodeMonoWavSamples(applySpeechEqWav(loudHigh)).samples;
  const loudStats = computeWavStats(encodePcm16MonoWav(loudEq, sr));
  assert.ok(loudStats.peak <= 31200, `Expected soft ceiling <= ~0.95 FS, got peak=${loudStats.peak}`);

  // applyHighPassWav preserves sampleRate and header cleanly
  const hpWav = applyHighPassWav(lowTone);
  assert.equal(decodeMonoWavSamples(hpWav).sampleRate, sr);
});
