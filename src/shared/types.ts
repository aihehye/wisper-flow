export type PlatformKind = 'win32' | 'linux' | 'darwin';

export type HudVisualState =
  | 'hidden'
  | 'resting'
  | 'ready'
  | 'active_ptt'
  | 'active_popo'
  | 'processing'
  | 'error';

export type DockPosition = 'bottom' | 'left' | 'right';

export type SoundSlot =
  | 'start'
  | 'stop'
  | 'popoLock'
  | 'paste'
  | 'error'
  | 'alert'
  | 'success'
  | 'achievement';

export type ThemeMode = 'system' | 'dark' | 'light' | 'omarchy';

export type LinuxPasteBackend = 'auto' | 'hyprctl' | 'wtype' | 'ydotool' | 'xdotool';

export type AsrStatusState =
  | 'uninitialized'
  | 'missing'
  | 'downloading'
  | 'starting'
  | 'ready'
  | 'error';

export interface ShortcutsConfig {
  pushToTalk: string;
  handsFree: string;
  cancel: string;
  pasteLast: string;
  copyLast: string;
}

export interface RumbleOptions {
  digits: boolean;
  filler: boolean; // false = <nofiller> (strip um/uh)
  verbatim: boolean; // true = <verbatim>
}

export interface CleanupOptions {
  stripExtraFillers: boolean;
  normalizeSpacing: boolean;
  spokenFormatting: boolean; // "new line", "new paragraph", "bullet point"
  allLowercaseGlobal: boolean;
  allLowercaseApps: string[];
}

export interface AppSettings {
  shortcuts: ShortcutsConfig;
  language: string; // 'auto' or Rumble-2-Flash language name/code
  microphoneDeviceId: string; // 'default' or device id/label
  gpuDeviceId: string; // 'auto' or e.g. 'Vulkan1'
  rumble: RumbleOptions;
  useDictionaryHints: boolean;
  launchAtLogin: boolean;
  hideFlowBarWhenIdle: boolean;
  dockPosition: DockPosition;
  enableSounds: boolean;
  customSoundDir: string;
  muteAudioWhileDictating: boolean;
  pauseMediaWhileDictating: boolean;
  restoreClipboardAfterPaste: boolean;
  terminalPasteMode: 'ctrl-shift-v' | 'shift-insert';
  linuxPasteBackend: LinuxPasteBackend;
  theme: ThemeMode;
  cleanup: CleanupOptions;
  whisperModeBoost: boolean; // high-gain mic boost toggle
  asrEngine: 'llama-server' | 'crispasr';
  customCrispAsrPath: string;
}

export interface DictionaryEntry {
  id: string;
  phrase: string;
  replacement: string | null; // null = vocabulary hint; non-null = exact replacement
  enabled: boolean;
  frequencyUsed: number;
  lastUsed: string | null;
  createdAt: string;
  modifiedAt: string;
}

export interface SnippetEntry {
  id: string;
  trigger: string;
  expansion: string;
  exactOnly: boolean;
  enabled: boolean;
  frequencyUsed: number;
  lastUsed: string | null;
  createdAt: string;
  modifiedAt: string;
}

export interface RegexRuleEntry {
  id: string;
  name: string;
  pattern: string;
  flags: string; // subset of g,i,m,u
  replacement: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  modifiedAt: string;
}

export interface HistoryEntry {
  id: string;
  timestamp: string;
  asrText: string;
  formattedText: string;
  pastedText: string;
  appName: string;
  windowTitle: string;
  durationSec: number;
  speechDurationSec: number;
  numWords: number;
  e2eLatencyMs: number;
  language: string;
  micDevice: string;
  archived: boolean;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  tokensEstimated?: boolean;
}

export interface DictionarySuggestion {
  id: string;
  phrase: string;
  replacement: string;
  appName: string | null;
  createdAt: string;
}

export interface TokenUsageBucket {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  dictations: number;
}

export interface TokenUsageStats {
  allTime: TokenUsageBucket & { measuredDictations: number };
  today: TokenUsageBucket;
  last7Days: TokenUsageBucket;
  byApp: Array<{ appName: string; totalTokens: number; dictations: number }>;
  byDay: Array<{
    date: string;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    dictations: number;
  }>;
  recent: Array<{
    id: string;
    timestamp: string;
    appName: string;
    numWords: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimated: boolean;
    textPreview: string;
  }>;
}

export interface UsageStats {
  totalWords: number;
  totalDictations: number;
  averageWpm: number;
  streakDays: number;
  timeSavedMinutes: number;
  todayWords: number;
}

export interface GpuDeviceInfo {
  id: string; // e.g. 'Vulkan0', 'Vulkan1', 'CPU'
  description: string;
  vendor: 'nvidia' | 'amd' | 'intel' | 'cpu' | 'other';
  isDiscrete: boolean;
}

export interface ModelStatus {
  state: AsrStatusState;
  engine: 'llama-server' | 'crispasr';
  modelName: string;
  modelPresent: boolean;
  mmprojPresent: boolean;
  runtimePresent: boolean;
  activeDeviceId: string;
  activeDeviceName: string;
  availableDevices: GpuDeviceInfo[];
  downloadProgress?: {
    file: string;
    downloadedBytes: number;
    totalBytes: number;
    percent: number;
  };
  errorMessage?: string;
}

export interface SoundSlotStatus {
  slot: SoundSlot;
  fileName: string;
  source: 'custom' | 'bundled';
  resolvedPath: string;
}

export interface OmarchyPalette {
  background?: string;
  foreground?: string;
  accent?: string;
  mode?: 'dark' | 'light';
  colors: Record<string, string>;
  sourcePath: string;
}

export interface OmarchyEnvironment {
  platform: PlatformKind;
  isLinux: boolean;
  isWayland: boolean;
  isHyprland: boolean;
  isOmarchy: boolean;
  omarchyVersion: 'v4-lua' | 'v3-conf' | 'hyprland-conf' | 'none';
  hyprDir: string;
  bindingsFile: string;
  windowRulesFile: string;
  autostartFile: string;
  themeHookInstalled: boolean;
  bindingsInstalled: boolean;
  windowRulesInstalled: boolean;
  palette: OmarchyPalette | null;
  availableTools: {
    hyprctl: boolean;
    wlCopy: boolean;
    wtype: boolean;
    ydotool: boolean;
    xdotool: boolean;
    xclip: boolean;
    pactl: boolean;
    pwRecord: boolean;
  };
  generatedLuaSnippet: string;
  generatedConfSnippet: string;
}

export interface HudPayload {
  state: HudVisualState;
  dockPosition: DockPosition;
  pushToTalkLabel: string;
  handsFreeLabel: string;
  microphoneDeviceId?: string;
  toastMessage?: string;
  toastKind?: 'info' | 'warning' | 'error';
  audioLevels?: number[]; // 10 normalized values 0..1
  recordingStartedAt?: number;
  palette?: OmarchyPalette | null;
}

export interface PipelineTrace {
  input: string;
  afterPrefixStrip: string;
  afterExactSnippet: string;
  afterDictionaryAndInlineSnippets: string;
  afterRegexRules: string;
  finalOutput: string;
  matchedExactSnippetId?: string;
  matchedDictionaryIds: string[];
  matchedSnippetIds: string[];
  appliedRegexRuleIds: string[];
}

export interface AudioDeviceOption {
  id: string;
  label: string;
}
