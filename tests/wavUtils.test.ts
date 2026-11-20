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
  splitWavIntoChunks,
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
