import type { LinuxPasteBackend, OmarchyEnvironment, OmarchyPalette, ShortcutsConfig } from '../../shared/types';

export interface ForegroundAppInfo {
  processName: string;
  title: string;
  isTerminal: boolean;
}

export interface FocusedTextResult {
  ok: boolean;
  text?: string;
  processName?: string;
  title?: string;
  reason?: string;
}

export interface PlatformPasteOptions {
  text: string;
  restoreClipboard: boolean;
  isTerminal: boolean;
  terminalMode: 'ctrl-shift-v' | 'shift-insert';
  linuxPasteBackend?: LinuxPasteBackend;
}

export type PlatformEventHandlers = {
  onPttDown: () => void;
  onPttUp: () => void;
  onPttOtherKey: (vkOrKey: string | number) => void;
  onHandsFreePressed: () => void;
  onCancelPressed: () => void;
  onPasteLastPressed: () => void;
  onCopyLastPressed: () => void;
  onShortcutCaptured: (shortcut: string) => void;
  // Extra direct IPC commands (primarily Linux Unix socket CLI)
  onDirectPttStart?: () => void;
  onDirectPttStop?: () => void;
  onDirectToggle?: () => void;
  onShowHub?: () => void;
  onToggleHud?: () => void;
  onReloadTheme?: () => void;
  onPaletteChanged?: (palette: OmarchyPalette | null) => void;
};

export interface PlatformBridge {
  readonly kind: 'win32' | 'linux';
  start(handlers: PlatformEventHandlers, shortcuts: ShortcutsConfig): Promise<void>;
  stop(): Promise<void>;
  updateShortcuts(shortcuts: ShortcutsConfig): Promise<void>;
  startShortcutCapture(): Promise<void>;
  stopShortcutCapture(): Promise<void>;
  getForegroundApp(): Promise<ForegroundAppInfo>;
  readFocusedText?(): Promise<FocusedTextResult>;
  pasteText(options: PlatformPasteOptions): Promise<{ ok: boolean; error?: string }>;
  copyText(text: string): Promise<{ ok: boolean; error?: string }>;
  muteOtherAudio(excludePids: number[]): Promise<void>;
  unmuteOtherAudio(): Promise<void>;
  pauseMedia?(excludePids: number[]): Promise<void>;
  resumeMedia?(): Promise<void>;
  focusNativeWindow?(hwnd: number | bigint): Promise<void>;
  getOmarchyEnvironment(): Promise<OmarchyEnvironment>;
  applyOmarchySetup?(): Promise<OmarchyEnvironment>;
  removeOmarchySetup?(): Promise<OmarchyEnvironment>;
  getHelperPids(): number[];
}
