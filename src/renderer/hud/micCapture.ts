import { RECORDING_SAMPLE_RATE } from '@shared/defaults';
import type { AudioDeviceOption, MicProfile } from '@shared/types';

export interface MicCaptureResult {
  wavBuffer: Uint8Array;
  opusBuffer?: Uint8Array;
  durationMs: number;
  speechDurationMs: number;
  peakLevel: number;
  deviceLabel: string;
}

export interface MicCaptureSession {
  stop: () => Promise<MicCaptureResult>;
  cancel: () => Promise<void>;
}

const WORKLET_PROCESSOR_CODE = `
class WisperPcmProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      const channel = input[0];
      const copy = new Float32Array(channel.length);
      copy.set(channel);
      this.port.postMessage(copy, [copy.buffer]);
    }
    return true;
  }
}
registerProcessor('wisper-pcm-processor', WisperPcmProcessor);
`;

const SPEECH_RMS_THRESHOLD = 0.014;
const BAR_COUNT = 10;

export const PRE_ROLL_MS = 250;
export const TAIL_DRAIN_MS = 150;
export const WHISPER_TARGET_RMS = 0.1; // -20 dBFS linear RMS
export const WHISPER_MAX_GAIN = 8.0;
export const WHISPER_ACTIVITY_RMS_FLOOR = 0.0015; // ~ -56.5 dBFS, aligns with quiet silence floor
export const SOFT_LIMITER_THRESHOLD = 0.75;
export const SOFT_LIMITER_CEILING = 0.95;

export class RollingPreRollBuffer {
  private readonly maxSamples: number;
  private chunks: Float32Array[] = [];
  private sampleCount = 0;

  constructor(maxSamples: number) {
    this.maxSamples = Math.max(0, Math.floor(maxSamples));
  }

  get totalSamples(): number {
    return this.sampleCount;
  }

  push(chunk: Float32Array): void {
    if (this.maxSamples <= 0 || chunk.length === 0) return;

    if (chunk.length >= this.maxSamples) {
      this.chunks = [new Float32Array(chunk.subarray(chunk.length - this.maxSamples))];
      this.sampleCount = this.maxSamples;
      return;
    }

    this.chunks.push(chunk);
    this.sampleCount += chunk.length;

    while (this.sampleCount > this.maxSamples && this.chunks.length > 0) {
      const excess = this.sampleCount - this.maxSamples;
      const head = this.chunks[0];
      if (head.length <= excess) {
        this.chunks.shift();
        this.sampleCount -= head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.sampleCount -= excess;
      }
    }
  }

  drain(): Float32Array[] {
    const out = this.chunks.map((c) => new Float32Array(c));
    this.chunks = [];
    this.sampleCount = 0;
    return out;
  }

  clear(): void {
    this.chunks = [];
    this.sampleCount = 0;
  }
}

export function softLimitSample(x: number): number {
  if (!Number.isFinite(x)) return 0;
  const abs = Math.abs(x);
  if (abs <= SOFT_LIMITER_THRESHOLD) return x;
  const headroom = SOFT_LIMITER_CEILING - SOFT_LIMITER_THRESHOLD;
  return (
    Math.sign(x) *
    (SOFT_LIMITER_THRESHOLD + headroom * Math.tanh((abs - SOFT_LIMITER_THRESHOLD) / headroom))
  );
}

export function computeActiveSpeechRms(samples: Float32Array, sampleRate: number): number {
  if (samples.length === 0 || sampleRate <= 0) return 0;
  const frameSize = Math.max(1, Math.round(sampleRate * 0.02)); // 20 ms frames
  const minTailSamples = samples.length < frameSize ? 1 : Math.max(1, Math.floor(frameSize / 2));
  const activeRms: number[] = [];

  for (let start = 0; start < samples.length; start += frameSize) {
    const end = Math.min(samples.length, start + frameSize);
    const len = end - start;
    if (len < minTailSamples) continue;

    let sumSq = 0;
    for (let i = start; i < end; i += 1) {
      const s = samples[i];
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / len);
    if (rms >= WHISPER_ACTIVITY_RMS_FLOOR) {
      activeRms.push(rms);
    }
  }

  if (activeRms.length === 0) return 0;
  activeRms.sort((a, b) => a - b);
  // 60th percentile of active frames ignores silence and resists single-frame click spikes
  const idx = Math.min(activeRms.length - 1, Math.floor((activeRms.length - 1) * 0.6));
  return activeRms[idx];
}

export function computeWhisperGainFromRms(activeRms: number, whisperMode: boolean): number {
  if (
    !whisperMode ||
    !Number.isFinite(activeRms) ||
    activeRms <= 0 ||
    activeRms >= WHISPER_TARGET_RMS
  ) {
    return 1;
  }
  return Math.min(WHISPER_MAX_GAIN, Math.max(1, WHISPER_TARGET_RMS / activeRms));
}

export function computeActiveSpeechWhisperGain(
  samples: Float32Array,
  sampleRate: number,
  whisperMode: boolean,
): number {
  if (!whisperMode || samples.length === 0 || sampleRate <= 0) {
    return 1;
  }
  const activeRms = computeActiveSpeechRms(samples, sampleRate);
  return computeWhisperGainFromRms(activeRms, whisperMode);
}

export async function enumerateAudioInputs(): Promise<AudioDeviceOption[]> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
    return [{ id: 'default', label: 'System Default' }];
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    const seen = new Set<string>();
    const options: AudioDeviceOption[] = [];

    for (let i = 0; i < inputs.length; i += 1) {
      const dev = inputs[i];
      const id = dev.deviceId || 'default';
      if (seen.has(id)) continue;
      seen.add(id);
      const label =
        dev.label?.trim() ||
        (id === 'default' ? 'System Default' : `Microphone ${options.length + 1}`);
      options.push({ id, label });
    }

    if (!options.some((d) => d.id === 'default')) {
      options.unshift({ id: 'default', label: 'System Default' });
    }
    return options;
  } catch {
    return [{ id: 'default', label: 'System Default' }];
  }
}

export function createAudioConstraints(
  deviceId?: string,
  micProfile: MicProfile = 'quiet',
): MediaStreamConstraints {
  const isNoisy = micProfile === 'noisy';
  const audio: MediaTrackConstraints = {
    channelCount: 1,
    echoCancellation: isNoisy,
    noiseSuppression: isNoisy,
    autoGainControl: isNoisy,
  };
  if (deviceId && deviceId !== 'default') {
    audio.deviceId = { exact: deviceId };
  }
  return { audio, video: false };
}

function getMediaErrorName(err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err && typeof err.name === 'string') {
    return err.name;
  }
  return '';
}

function mapMediaError(err: unknown): Error {
  const name = getMediaErrorName(err);
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return new Error('Microphone permission denied — allow microphone access in system settings');
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return new Error('No microphone device found');
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return new Error('Microphone is in use or unreadable by another application');
  }
  return err instanceof Error ? err : new Error('Microphone access failed');
}

async function openMicStream(
  deviceId?: string,
  micProfile: MicProfile = 'quiet',
): Promise<MediaStream> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone API is unavailable in this environment');
  }

  try {
    return await navigator.mediaDevices.getUserMedia(createAudioConstraints(deviceId, micProfile));
  } catch (err) {
    const name = getMediaErrorName(err);
    const canFallbackToDefault =
      Boolean(deviceId && deviceId !== 'default') &&
      (name === 'OverconstrainedError' || name === 'NotFoundError' || name === 'DevicesNotFoundError');

    if (!canFallbackToDefault) {
      throw mapMediaError(err);
    }

    try {
      return await navigator.mediaDevices.getUserMedia(createAudioConstraints('default', micProfile));
    } catch (fallbackErr) {
      throw mapMediaError(fallbackErr);
    }
  }
}

export function resampleFloat32(
  chunks: Float32Array[],
  inputSampleRate: number,
  targetSampleRate: number,
  whisperMode: boolean,
): { pcm: Float32Array; peak: number; speechDurationMs: number } {
  let totalSamples = 0;
  for (const c of chunks) {
    totalSamples += c.length;
  }

  if (totalSamples === 0) {
    return { pcm: new Float32Array(0), peak: 0, speechDurationMs: 0 };
  }

  const merged = new Float32Array(totalSamples);
  let offset = 0;
  let rawPeak = 0;
  let speechFrames = 0;
  const frameSize = Math.max(1, Math.round(inputSampleRate * 0.02)); // 20 ms window

  for (const c of chunks) {
    for (let i = 0; i < c.length; i += 1) {
      const s = Math.max(-1, Math.min(1, c[i]));
      merged[offset + i] = s;
      const abs = Math.abs(s);
      if (abs > rawPeak) rawPeak = abs;
    }
    offset += c.length;
  }

  // Compute speechDurationMs on raw audio before applying any whisper boost
  for (let start = 0; start < merged.length; start += frameSize) {
    const end = Math.min(merged.length, start + frameSize);
    let sumSq = 0;
    for (let i = start; i < end; i += 1) {
      sumSq += merged[i] * merged[i];
    }
    const rms = Math.sqrt(sumSq / Math.max(1, end - start));
    if (rms >= SPEECH_RMS_THRESHOLD) {
      speechFrames += 1;
    }
  }
  const speechDurationMs = speechFrames * 20;

  const gain = computeActiveSpeechWhisperGain(merged, inputSampleRate, whisperMode);
  let peak = rawPeak;
  if (gain !== 1 || rawPeak > SOFT_LIMITER_THRESHOLD) {
    peak = 0;
    for (let i = 0; i < merged.length; i += 1) {
      const limited = softLimitSample(merged[i] * gain);
      merged[i] = limited;
      const abs = Math.abs(limited);
      if (abs > peak) peak = abs;
    }
  }

  if (inputSampleRate === targetSampleRate) {
    return { pcm: merged, peak, speechDurationMs };
  }

  const ratio = inputSampleRate / targetSampleRate;
  const outLength = Math.max(1, Math.floor(merged.length / ratio));
  const out = new Float32Array(outLength);

  if (ratio > 1) {
    // Anti-aliased box-averaging + linear interpolation for clean downsampling
    for (let i = 0; i < outLength; i += 1) {
      const srcStart = i * ratio;
      const srcEnd = Math.min(merged.length, (i + 1) * ratio);
      const startIdx = Math.floor(srcStart);
      const endIdx = Math.min(merged.length - 1, Math.ceil(srcEnd));
      let sum = 0;
      let count = 0;
      for (let j = startIdx; j <= endIdx; j += 1) {
        sum += merged[j];
        count += 1;
      }
      out[i] = count > 0 ? sum / count : 0;
    }
  } else {
    for (let i = 0; i < outLength; i += 1) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const next = Math.min(merged.length - 1, idx + 1);
      out[i] = merged[idx] * (1 - frac) + merged[next] * frac;
    }
  }

  return { pcm: out, peak, speechDurationMs };
}

export function encodeWavInt16(samples: Float32Array, sampleRate: number): Uint8Array {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i += 1) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let writeOffset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const int16 = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    view.setInt16(writeOffset, int16, true);
    writeOffset += 2;
  }

  return new Uint8Array(buffer);
}

function computeCenterSymmetricBars(
  analyser: AnalyserNode,
  freqData: Uint8Array<ArrayBuffer>,
  timeData: Uint8Array<ArrayBuffer>,
  prevBars: number[],
  whisperMode: boolean,
): { bars: number[]; rms: number } {
  analyser.getByteFrequencyData(freqData);
  analyser.getByteTimeDomainData(timeData);

  let sumSq = 0;
  for (let i = 0; i < timeData.length; i += 1) {
    const norm = (timeData[i] - 128) / 128;
    sumSq += norm * norm;
  }
  const rawRms = Math.sqrt(sumSq / Math.max(1, timeData.length));
  const boostedRms = Math.min(1, rawRms * (whisperMode ? 5.2 : 3.2));

  // 5 half-spectrum bands mirrored from center outward: [b4, b3, b2, b1, b0, b0, b1, b2, b3, b4]
  const halfCount = BAR_COUNT / 2;
  const binRanges: Array<[number, number]> = [
    [1, 3],
    [3, 7],
    [7, 14],
    [14, 26],
    [26, 46],
  ];

  const halfValues: number[] = [];
  for (let band = 0; band < halfCount; band += 1) {
    const [start, end] = binRanges[band];
    let total = 0;
    let count = 0;
    for (let b = start; b < Math.min(end, freqData.length); b += 1) {
      total += freqData[b] / 255;
      count += 1;
    }
    const bandEnergy = count > 0 ? total / count : 0;
    const gain = whisperMode ? 1.85 : 1.25;
    const combined = Math.min(1, Math.max(0, bandEnergy * gain * 0.72 + boostedRms * 0.45));
    halfValues.push(combined);
  }

  const nextBars = new Array<number>(BAR_COUNT);
  for (let i = 0; i < halfCount; i += 1) {
    const val = halfValues[i];
    const leftIdx = halfCount - 1 - i;
    const rightIdx = halfCount + i;
    const smoothLeft = prevBars[leftIdx] * 0.35 + val * 0.65;
    const smoothRight = prevBars[rightIdx] * 0.35 + val * 0.65;
    nextBars[leftIdx] = Math.max(0.04, Math.min(1, smoothLeft));
    nextBars[rightIdx] = Math.max(0.04, Math.min(1, smoothRight));
  }

  return { bars: nextBars, rms: boostedRms };
}

interface WarmMicPipeline {
  deviceId: string;
  micProfile: MicProfile;
  deviceLabel: string;
  stream: MediaStream;
  track: MediaStreamTrack | undefined;
  ctx: AudioContext;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  silentGain: GainNode;
  workletNode: AudioWorkletNode | null;
  scriptNode: ScriptProcessorNode | null;
  blobUrl: string | null;
  preRoll: RollingPreRollBuffer;
  activeSink: ((chunk: Float32Array) => void) | null;
  disposed: boolean;
  dispose: () => Promise<void>;
}

let warmPipeline: WarmMicPipeline | null = null;
let warmOpChain: Promise<unknown> = Promise.resolve();

function serializeWarmOp<T>(fn: () => Promise<T>): Promise<T> {
  const next = warmOpChain.then(fn, fn);
  warmOpChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function normalizeDeviceId(deviceId?: string): string {
  return deviceId && deviceId.trim().length > 0 ? deviceId : 'default';
}

function isPipelineAlive(
  pipeline: WarmMicPipeline | null,
  deviceId?: string,
  micProfile?: MicProfile,
): boolean {
  if (!pipeline || pipeline.disposed) return false;
  if (deviceId !== undefined && pipeline.deviceId !== normalizeDeviceId(deviceId)) return false;
  if (micProfile !== undefined && pipeline.micProfile !== micProfile) return false;
  if (pipeline.ctx.state === 'closed') return false;
  const track = pipeline.track;
  if (!track || track.readyState !== 'live') return false;
  return true;
}

export function isWarmMicHealthy(deviceId?: string, micProfile?: MicProfile): boolean {
  return isPipelineAlive(warmPipeline, deviceId, micProfile);
}

async function createWarmPipeline(deviceId: string, micProfile: MicProfile): Promise<WarmMicPipeline> {
  const stream = await openMicStream(deviceId, micProfile);
  const track = stream.getAudioTracks()[0];
  const deviceLabel = track?.label || 'Default Microphone';

  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx({ sampleRate: RECORDING_SAMPLE_RATE, latencyHint: 'interactive' });

  let source: MediaStreamAudioSourceNode | null = null;
  let analyser: AnalyserNode | null = null;
  let silentGain: GainNode | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let scriptNode: ScriptProcessorNode | null = null;
  let blobUrl: string | null = null;

  try {
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    source = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.65;

    silentGain = ctx.createGain();
    silentGain.gain.value = 0;

    const actualSampleRate = ctx.sampleRate || RECORDING_SAMPLE_RATE;
    const preRollMaxSamples = Math.round((actualSampleRate * PRE_ROLL_MS) / 1000);
    const preRoll = new RollingPreRollBuffer(preRollMaxSamples);

    const pipeline: WarmMicPipeline = {
      deviceId,
      micProfile,
      deviceLabel,
      stream,
      track,
      ctx,
      source,
      analyser,
      silentGain,
      workletNode: null,
      scriptNode: null,
      blobUrl: null,
      preRoll,
      activeSink: null,
      disposed: false,
      dispose: async () => {
        if (pipeline.disposed) return;
        pipeline.disposed = true;
        pipeline.activeSink = null;
        pipeline.preRoll.clear();

        if (pipeline.track) {
          pipeline.track.onended = null;
        }
        try {
          pipeline.source.disconnect();
        } catch {}
        try {
          pipeline.analyser.disconnect();
        } catch {}
        try {
          pipeline.workletNode?.disconnect();
          if (pipeline.workletNode) pipeline.workletNode.port.onmessage = null;
        } catch {}
        try {
          pipeline.scriptNode?.disconnect();
          if (pipeline.scriptNode) pipeline.scriptNode.onaudioprocess = null;
        } catch {}
        try {
          pipeline.silentGain.disconnect();
        } catch {}

        for (const t of pipeline.stream.getTracks()) {
          try {
            t.stop();
          } catch {}
        }

        if (pipeline.blobUrl) {
          URL.revokeObjectURL(pipeline.blobUrl);
          pipeline.blobUrl = null;
        }

        try {
          if (pipeline.ctx.state !== 'closed') {
            await pipeline.ctx.close();
          }
        } catch {}

        if (warmPipeline === pipeline) {
          warmPipeline = null;
        }
      },
    };

    const handlePcmChunk = (chunk: Float32Array) => {
      if (pipeline.disposed || chunk.length === 0) return;
      if (pipeline.activeSink) {
        pipeline.activeSink(chunk);
      } else {
        pipeline.preRoll.push(chunk);
      }
    };

    source.connect(analyser);

    let usedWorklet = false;
    if (ctx.audioWorklet && typeof Blob !== 'undefined' && typeof URL !== 'undefined') {
      try {
        const blob = new Blob([WORKLET_PROCESSOR_CODE], { type: 'application/javascript' });
        blobUrl = URL.createObjectURL(blob);
        pipeline.blobUrl = blobUrl;
        await ctx.audioWorklet.addModule(blobUrl);
        workletNode = new AudioWorkletNode(ctx, 'wisper-pcm-processor');
        workletNode.port.onmessage = (ev: MessageEvent<Float32Array>) => {
          if (ev.data instanceof Float32Array) {
            handlePcmChunk(ev.data);
          }
        };
        source.connect(workletNode);
        workletNode.connect(silentGain);
        silentGain.connect(ctx.destination);
        pipeline.workletNode = workletNode;
        usedWorklet = true;
      } catch {
        usedWorklet = false;
        if (blobUrl) {
          URL.revokeObjectURL(blobUrl);
          blobUrl = null;
          pipeline.blobUrl = null;
        }
      }
    }

    if (!usedWorklet) {
      scriptNode = ctx.createScriptProcessor(2048, 1, 1);
      scriptNode.onaudioprocess = (ev: AudioProcessingEvent) => {
        const input = ev.inputBuffer.getChannelData(0);
        if (input.length > 0) {
          handlePcmChunk(new Float32Array(input));
        }
      };
      source.connect(scriptNode);
      scriptNode.connect(silentGain);
      silentGain.connect(ctx.destination);
      pipeline.scriptNode = scriptNode;
    }

    if (track) {
      track.onended = () => {
        // If track ended while idle, dispose so next warm/start re-acquires cleanly.
        if (!pipeline.disposed && !pipeline.activeSink) {
          void pipeline.dispose();
        }
      };
    }

    return pipeline;
  } catch (err) {
    try {
      source?.disconnect();
      analyser?.disconnect();
      workletNode?.disconnect();
      scriptNode?.disconnect();
      silentGain?.disconnect();
    } catch {}
    for (const t of stream.getTracks()) {
      try {
        t.stop();
      } catch {}
    }
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
    }
    try {
      if (ctx.state !== 'closed') {
        await ctx.close();
      }
    } catch {}
    throw err;
  }
}

async function ensureWarmPipeline(
  deviceId?: string,
  options?: { forceRefresh?: boolean; micProfile?: MicProfile },
): Promise<WarmMicPipeline> {
  const targetId = normalizeDeviceId(deviceId);
  const targetProfile: MicProfile = options?.micProfile ?? 'quiet';
  if (!options?.forceRefresh && isPipelineAlive(warmPipeline, targetId, targetProfile)) {
    const existing = warmPipeline!;
    if (existing.ctx.state === 'suspended') {
      await existing.ctx.resume();
    }
    return existing;
  }

  if (warmPipeline) {
    await warmPipeline.dispose();
    warmPipeline = null;
  }

  const created = await createWarmPipeline(targetId, targetProfile);
  warmPipeline = created;
  return created;
}

export async function warmMic(
  deviceId?: string,
  options?: { forceRefresh?: boolean; micProfile?: MicProfile },
): Promise<void> {
  await serializeWarmOp(async () => {
    await ensureWarmPipeline(deviceId, options);
  });
}

export async function disposeWarmMic(): Promise<void> {
  await serializeWarmOp(async () => {
    if (warmPipeline) {
      await warmPipeline.dispose();
      warmPipeline = null;
    }
  });
}

interface OpusRecorderHandle {
  stop: () => Promise<Uint8Array | undefined>;
  cancel: () => void;
}

const OPUS_MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm'] as const;
const OPUS_BITS_PER_SECOND = 64000;
const OPUS_STOP_TIMEOUT_MS = 600;

function startOpusRecorder(stream: MediaStream): OpusRecorderHandle | null {
  if (typeof MediaRecorder === 'undefined') {
    return null;
  }

  try {
    let mimeType: string | undefined;
    if (typeof MediaRecorder.isTypeSupported === 'function') {
      mimeType = OPUS_MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
      if (!mimeType) {
        return null;
      }
    } else {
      mimeType = 'audio/webm;codecs=opus';
    }

    const recorder = new MediaRecorder(stream, {
      mimeType,
      audioBitsPerSecond: OPUS_BITS_PER_SECOND,
    });

    const chunks: Blob[] = [];
    let cancelled = false;

    recorder.ondataavailable = (ev: BlobEvent) => {
      if (!cancelled && ev.data && ev.data.size > 0) {
        chunks.push(ev.data);
      }
    };

    recorder.start(250);

    return {
      stop: () =>
        new Promise<Uint8Array | undefined>((resolve) => {
          if (cancelled) {
            resolve(undefined);
            return;
          }

          const finalize = async () => {
            if (cancelled || chunks.length === 0) {
              resolve(undefined);
              return;
            }
            try {
              const blob = new Blob(chunks, {
                type: recorder.mimeType || mimeType || 'audio/webm;codecs=opus',
              });
              const ab = await blob.arrayBuffer();
              resolve(ab.byteLength > 0 ? new Uint8Array(ab) : undefined);
            } catch {
              resolve(undefined);
            }
          };

          if (recorder.state === 'inactive') {
            void finalize();
            return;
          }

          let settled = false;
          const done = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            void finalize();
          };

          const timeout = setTimeout(done, OPUS_STOP_TIMEOUT_MS);
          recorder.onstop = done;
          recorder.onerror = done;

          try {
            recorder.stop();
          } catch {
            done();
          }
        }),
      cancel: () => {
        cancelled = true;
        chunks.length = 0;
        try {
          if (recorder.state !== 'inactive') {
            recorder.stop();
          }
        } catch {}
      },
    };
  } catch {
    return null;
  }
}

export async function startMicCapture(options: {
  deviceId?: string;
  micProfile?: MicProfile;
  whisperMode?: boolean;
  onLevels?: (bars: number[]) => void;
}): Promise<MicCaptureSession> {
  const micProfile: MicProfile = options.micProfile ?? 'quiet';
  const whisperMode = Boolean(options.whisperMode) || micProfile === 'quiet';
  const pipeline = await serializeWarmOp(() =>
    ensureWarmPipeline(options.deviceId, { micProfile }),
  );

  const chunks: Float32Array[] = pipeline.preRoll.drain();
  let sessionClosed = false;
  const startedAt = performance.now();

  pipeline.activeSink = (chunk: Float32Array) => {
    if (!sessionClosed) {
      chunks.push(chunk);
    }
  };
  const opusRecorder = startOpusRecorder(pipeline.stream);

  const { analyser, ctx, deviceLabel } = pipeline;
  const freqData = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
  const timeData = new Uint8Array(new ArrayBuffer(analyser.fftSize));
  let currentBars = new Array<number>(BAR_COUNT).fill(0.06);
  let rafId = 0;
  let lastEmit = 0;

  const tick = (now: number) => {
    if (sessionClosed || pipeline.disposed) return;
    if (now - lastEmit >= 28) {
      lastEmit = now;
      const { bars } = computeCenterSymmetricBars(
        analyser,
        freqData,
        timeData,
        currentBars,
        whisperMode,
      );
      currentBars = bars;
      options.onLevels?.(bars);
    }
    rafId = requestAnimationFrame(tick);
  };

  if (options.onLevels) {
    rafId = requestAnimationFrame(tick);
  }

  const releaseSession = () => {
    if (sessionClosed) return;
    sessionClosed = true;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (!pipeline.disposed) {
      pipeline.activeSink = null;
      pipeline.preRoll.clear();
    }
  };

  return {
    stop: async () => {
      const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
      // Drain tail audio from OS / AudioWorklet buffers before ending capture
      await new Promise<void>((resolve) => setTimeout(resolve, TAIL_DRAIN_MS));
      const actualSampleRate = ctx.sampleRate || RECORDING_SAMPLE_RATE;
      releaseSession();
      const opusPromise = opusRecorder ? opusRecorder.stop() : Promise.resolve(undefined);

      const { pcm, peak, speechDurationMs } = resampleFloat32(
        chunks,
        actualSampleRate,
        RECORDING_SAMPLE_RATE,
        whisperMode,
      );
      const wavBuffer = encodeWavInt16(pcm, RECORDING_SAMPLE_RATE);
      const opusBuffer = await opusPromise;
      return {
        wavBuffer,
        opusBuffer,
        durationMs,
        speechDurationMs,
        peakLevel: peak,
        deviceLabel,
      };
    },
    cancel: async () => {
      chunks.length = 0;
      opusRecorder?.cancel();
      releaseSession();
    },
  };
}

export async function startMicLevelMonitor(
  deviceId: string | undefined,
  whisperMode: boolean,
  onLevel: (level: number, peakZero: boolean) => void,
  micProfile: MicProfile = 'quiet',
): Promise<() => Promise<void>> {
  const effectiveWhisperMode = whisperMode || micProfile === 'quiet';
  const stream = await openMicStream(deviceId, micProfile);
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx({ latencyHint: 'interactive' });
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }

  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);

  const freqData = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
  const timeData = new Uint8Array(new ArrayBuffer(analyser.fftSize));
  let bars = new Array<number>(BAR_COUNT).fill(0);
  let closed = false;
  let rafId = 0;
  let seenNonZero = false;

  const loop = () => {
    if (closed) return;
    const { bars: nextBars, rms } = computeCenterSymmetricBars(
      analyser,
      freqData,
      timeData,
      bars,
      effectiveWhisperMode,
    );
    bars = nextBars;
    if (rms > 0.001) seenNonZero = true;
    onLevel(rms, !seenNonZero);
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);

  return async () => {
    if (closed) return;
    closed = true;
    if (rafId) cancelAnimationFrame(rafId);
    try {
      source.disconnect();
      analyser.disconnect();
    } catch {}
    for (const t of stream.getTracks()) {
      try {
        t.stop();
      } catch {}
    }
    try {
      await ctx.close();
    } catch {}
  };
}
