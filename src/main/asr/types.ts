import type { AsrStatusState, GpuDeviceInfo, MicProfile, ModelStatus, RumbleOptions } from '../../shared/types';

export interface TranscribeRequest {
  wavBuffer: Buffer;
  language: string; // 'auto' or e.g. 'English', 'en'
  rumble: RumbleOptions;
  contextHints?: string[]; // Vocabulary hints from Dictionary
  micProfile?: MicProfile;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated?: boolean;
}

export interface TranscribeResult {
  rawText: string;
  detectedLanguage?: string;
  asrLatencyMs: number;
  usage?: TokenUsage;
}

export interface AsrBackend {
  readonly id: 'llama-server' | 'crispasr';
  start(options: { gpuDeviceId: string; customBinaryPath?: string }): Promise<void>;
  stop(): Promise<void>;
  restart(options: { gpuDeviceId: string; customBinaryPath?: string }): Promise<void>;
  listDevices(): Promise<GpuDeviceInfo[]>;
  getStatus(): ModelStatus;
  transcribe(req: TranscribeRequest): Promise<TranscribeResult>;
  onStatusChange(cb: (status: ModelStatus) => void): () => void;
}

export type StatusUpdater = (patch: Partial<ModelStatus> & { state?: AsrStatusState }) => void;
