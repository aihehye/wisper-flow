import type {
  AppSettings,
  DockPosition,
  ShortcutsConfig,
  SoundSlot,
} from '../shared/types';

export type HubPage = 'home' | 'dictionary' | 'snippets' | 'regex' | 'settings';
export type SettingsTab = 'general' | 'model' | 'system' | 'cleanup' | 'omarchy';

export interface HistoryListQuery {
  search?: string;
  limit?: number;
  offset?: number;
  includeArchived?: boolean;
}

export interface SmokeTestResult {
  ok: boolean;
  latencyMs?: number;
  text?: string;
  error?: string;
}

export interface HudActionPayload {
  type:
    | 'click-toggle'
    | 'cancel'
    | 'stop'
    | 'open-hub'
    | 'open-shortcuts'
    | 'paste-last'
    | 'set-dock'
    | 'toggle-hide'
    | 'set-mic'
    | 'set-mic-profile'
    | 'set-language';
  value?: DockPosition | string | boolean;
}

export interface HudAudioSubmitPayload {
  sessionId: string;
  wavBuffer: Uint8Array;
  opusBuffer?: Uint8Array;
  durationMs: number;
  speechDurationMs: number;
  peakLevel: number;
  deviceLabel?: string;
  error?: string;
}

export type SettingsPatch = Partial<AppSettings>;
export type ShortcutField = keyof ShortcutsConfig;
export type PlaySlot = SoundSlot;
