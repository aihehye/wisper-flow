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

const DEFAULT_SAMPLE_RATE = 16000;
const FRAME_SILENCE_RMS_THRESHOLD = 120; // ~ -48.7 dBFS over 20ms frames

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
 * Trims leading and trailing silence using 20ms frame-RMS gating (immune to single-sample clicks)
 * while preserving gentle speech onset/offset padding.
 */
export function trimSilenceWav(wavBuf: Buffer, keepHeadMs = 80, keepTailMs = 110): Buffer {
  const { sampleRate, samples } = decodeMonoWavSamples(wavBuf);
  const numSamples = samples.length;
  if (numSamples === 0 || sampleRate <= 0) return wavBuf;

  const frameLen = Math.max(1, Math.floor(sampleRate * 0.02)); // 20 ms frames
  const numFrames = Math.ceil(numSamples / frameLen);

  const isFrameActive = (frameIdx: number): boolean => {
    const start = frameIdx * frameLen;
    const end = Math.min(numSamples, start + frameLen);
    let sumSq = 0;
    for (let i = start; i < end; i++) {
      const s = samples[i];
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, end - start));
    return rms >= FRAME_SILENCE_RMS_THRESHOLD;
  };

  let firstActiveFrame = 0;
  while (firstActiveFrame < numFrames && !isFrameActive(firstActiveFrame)) {
    firstActiveFrame++;
  }
  if (firstActiveFrame >= numFrames) {
    return wavBuf;
  }

  let lastActiveFrame = numFrames - 1;
  while (lastActiveFrame > firstActiveFrame && !isFrameActive(lastActiveFrame)) {
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
 * Splits audio longer than `maxChunkSec` at the lowest-energy 150 ms valley
 * between `minChunkSec` and `maxChunkSec` recursively, with `overlapMs` overlap
 * so words at chunk boundaries are not chopped.
 */
export function splitWavIntoChunks(
  wavBuf: Buffer,
  maxChunkSec = 28,
  minChunkSec = 16,
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
