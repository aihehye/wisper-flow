import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC } from '../shared/ipcChannels';
import type {
  AppSettings,
  AudioDeviceOption,
  DictionaryEntry,
  HistoryEntry,
  ModelStatus,
  OmarchyEnvironment,
  OmarchyPalette,
  PipelineTrace,
  RegexRuleEntry,
  ShortcutsConfig,
  SnippetEntry,
  SoundSlot,
  SoundSlotStatus,
  UsageStats,
} from '../shared/types';

export type HubPage = 'home' | 'dictionary' | 'snippets' | 'regex' | 'settings';

export type SettingsTab = 'general' | 'model' | 'system' | 'cleanup' | 'omarchy';

export interface NavigatePayload {
  page: HubPage;
  settingsTab?: SettingsTab;
}

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

export interface PlaySoundPayload {
  slot: SoundSlot;
  dataUrl: string;
}

export type ShortcutCapturedPayload =
  | string
  | {
      field?: keyof ShortcutsConfig;
      shortcut: string;
    };

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T) => {
    handler(payload);
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

export const wisperHubApi = {
  // Settings
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.SETTINGS_GET),
  updateSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.SETTINGS_UPDATE, patch),
  captureShortcutStart: (field?: keyof ShortcutsConfig): Promise<void> =>
    ipcRenderer.invoke(IPC.SETTINGS_CAPTURE_SHORTCUT_START, field),
  captureShortcutStop: (): Promise<void> =>
    ipcRenderer.invoke(IPC.SETTINGS_CAPTURE_SHORTCUT_STOP),

  // Dictionary
  listDictionary: (): Promise<DictionaryEntry[]> => ipcRenderer.invoke(IPC.DICTIONARY_LIST),
  upsertDictionary: (
    entry: Partial<DictionaryEntry> & { phrase: string; replacement: string | null },
  ): Promise<DictionaryEntry> => ipcRenderer.invoke(IPC.DICTIONARY_UPSERT, entry),
  deleteDictionary: (id: string): Promise<void> => ipcRenderer.invoke(IPC.DICTIONARY_DELETE, id),

  // Snippets
  listSnippets: (): Promise<SnippetEntry[]> => ipcRenderer.invoke(IPC.SNIPPETS_LIST),
  upsertSnippet: (
    entry: Partial<SnippetEntry> & { trigger: string; expansion: string },
  ): Promise<SnippetEntry> => ipcRenderer.invoke(IPC.SNIPPETS_UPSERT, entry),
  deleteSnippet: (id: string): Promise<void> => ipcRenderer.invoke(IPC.SNIPPETS_DELETE, id),

  // Regex rules & pipeline test
  listRegexRules: (): Promise<RegexRuleEntry[]> => ipcRenderer.invoke(IPC.REGEX_LIST),
  upsertRegexRule: (
    entry: Partial<RegexRuleEntry> & {
      name: string;
      pattern: string;
      flags: string;
      replacement: string;
    },
  ): Promise<RegexRuleEntry> => ipcRenderer.invoke(IPC.REGEX_UPSERT, entry),
  deleteRegexRule: (id: string): Promise<void> => ipcRenderer.invoke(IPC.REGEX_DELETE, id),
  reorderRegexRules: (orderedIds: string[]): Promise<RegexRuleEntry[]> =>
    ipcRenderer.invoke(IPC.REGEX_REORDER, orderedIds),
  testPipeline: (input: string, appName?: string): Promise<PipelineTrace> =>
    ipcRenderer.invoke(IPC.PIPELINE_TEST, input, appName),

  // History & stats
  listHistory: (query?: HistoryListQuery): Promise<HistoryEntry[]> =>
    ipcRenderer.invoke(IPC.HISTORY_LIST, query),
  deleteHistory: (id: string): Promise<void> => ipcRenderer.invoke(IPC.HISTORY_DELETE, id),
  clearHistory: (): Promise<void> => ipcRenderer.invoke(IPC.HISTORY_CLEAR),
  pasteHistoryEntry: (id: string): Promise<void> => ipcRenderer.invoke(IPC.HISTORY_PASTE_ENTRY, id),
  copyHistoryEntry: (id: string): Promise<void> => ipcRenderer.invoke(IPC.HISTORY_COPY_ENTRY, id),
  getStats: (): Promise<UsageStats> => ipcRenderer.invoke(IPC.STATS_GET),

  // Model & GPU
  getModelStatus: (): Promise<ModelStatus> => ipcRenderer.invoke(IPC.MODEL_STATUS),
  downloadModel: (): Promise<ModelStatus> => ipcRenderer.invoke(IPC.MODEL_DOWNLOAD),
  restartModel: (): Promise<ModelStatus> => ipcRenderer.invoke(IPC.MODEL_RESTART),
  testModelSmoke: (): Promise<SmokeTestResult> => ipcRenderer.invoke(IPC.MODEL_TEST_SMOKE),

  // Sounds
  listSoundStatuses: (): Promise<SoundSlotStatus[]> => ipcRenderer.invoke(IPC.SOUNDS_LIST_STATUS),
  browseSoundDir: (): Promise<string | null> => ipcRenderer.invoke(IPC.SOUNDS_BROWSE_DIR),
  playSoundPreview: (slot: SoundSlot): Promise<void> =>
    ipcRenderer.invoke(IPC.SOUNDS_PLAY_PREVIEW, slot),

  // Omarchy & Linux
  getOmarchyStatus: (): Promise<OmarchyEnvironment> => ipcRenderer.invoke(IPC.OMARCHY_STATUS),
  applyOmarchySetup: (): Promise<OmarchyEnvironment> => ipcRenderer.invoke(IPC.OMARCHY_APPLY),
  removeOmarchySetup: (): Promise<OmarchyEnvironment> => ipcRenderer.invoke(IPC.OMARCHY_REMOVE),
  refreshOmarchy: (): Promise<OmarchyEnvironment> => ipcRenderer.invoke(IPC.OMARCHY_REFRESH),

  // Audio devices
  setAudioDevices: (devices: AudioDeviceOption[]): Promise<void> =>
    ipcRenderer.invoke(IPC.AUDIO_DEVICES_SET, devices),
  getAudioDevices: (): Promise<AudioDeviceOption[]> => ipcRenderer.invoke(IPC.AUDIO_DEVICES_GET),

  // Main -> Hub event subscriptions
  onShortcutCaptured: (cb: (payload: ShortcutCapturedPayload) => void): (() => void) =>
    subscribe<ShortcutCapturedPayload>(IPC.EVENT_SHORTCUT_CAPTURED, cb),
  onModelStatus: (cb: (status: ModelStatus) => void): (() => void) =>
    subscribe<ModelStatus>(IPC.EVENT_MODEL_STATUS, cb),
  onSettingsChanged: (cb: (settings: AppSettings) => void): (() => void) =>
    subscribe<AppSettings>(IPC.EVENT_SETTINGS_CHANGED, cb),
  onHistoryAdded: (cb: (entry: HistoryEntry) => void): (() => void) =>
    subscribe<HistoryEntry>(IPC.EVENT_HISTORY_ADDED, cb),
  onOmarchyPalette: (cb: (palette: OmarchyPalette | null) => void): (() => void) =>
    subscribe<OmarchyPalette | null>(IPC.EVENT_OMARCHY_PALETTE, cb),
  onNavigate: (cb: (target: HubPage | NavigatePayload) => void): (() => void) =>
    subscribe<HubPage | NavigatePayload>(IPC.EVENT_NAVIGATE, cb),
  onPlaySound: (cb: (payload: PlaySoundPayload) => void): (() => void) =>
    subscribe<PlaySoundPayload>(IPC.EVENT_PLAY_SOUND, cb),
};

export type WisperHubApi = typeof wisperHubApi;

declare global {
  interface Window {
    wisperHub: WisperHubApi;
  }
}

contextBridge.exposeInMainWorld('wisperHub', wisperHubApi);
