import { app, dialog, ipcMain, Menu, type BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RUMBLE_LANGUAGES } from '../shared/defaults';
import { IPC } from '../shared/ipcChannels';
import type {
  AppSettings,
  AudioDeviceOption,
  DictionaryEntry,
  DockPosition,
  HistoryEntry,
  MicProfile,
  ModelStatus,
  OmarchyPalette,
  RegexRuleEntry,
  ShortcutsConfig,
  SnippetEntry,
  SoundSlot,
} from '../shared/types';
import type { AsrBackend } from './asr/types';
import { downloadModelAndRuntime } from './asr/modelManager';
import { computeWavStats, encodePcm16MonoWav } from './asr/wavUtils';
import { runTextPipeline } from './pipeline/textPipeline';
import type { PlatformBridge } from './platform/types';
import type { SoundResolver } from './sounds/soundResolver';
import type { DictationStateMachine } from './stateMachine';
import type { CorpusStore } from './storage/corpusStore';
import type { AppDatabase } from './storage/db';
import { computeUsageStats, getTokenUsageStats } from './storage/stats';
import type { AppTrayController } from './tray';
import { showAndFocusHub } from './windows/hubWindow';
import type { HudWindowController } from './windows/hudWindow';
import type {
  HistoryListQuery,
  HubPage,
  HudActionPayload,
  HudAudioSubmitPayload,
  SettingsTab,
  SmokeTestResult,
} from './ipcTypes';

const execFileAsync = promisify(execFile);

export interface AppRuntimeContext {
  db: AppDatabase;
  corpusStore?: CorpusStore;
  platform: PlatformBridge;
  getAsr: () => AsrBackend;
  switchAsrEngine: (engine: 'llama-server' | 'crispasr', settings: AppSettings) => Promise<void>;
  stateMachine: DictationStateMachine;
  soundResolver: SoundResolver;
  getHubWindow: () => BrowserWindow | null;
  getHudController: () => HudWindowController | null;
  getTray: () => AppTrayController | null;
  getAudioDevices: () => AudioDeviceOption[];
  setAudioDevices: (devices: AudioDeviceOption[]) => void;
  getLatestPalette: () => OmarchyPalette | null;
  setLatestPalette: (palette: OmarchyPalette | null) => void;
  playSoundOnWindow: (target: 'hud' | 'hub', slot: SoundSlot) => void;
  setCapturingShortcutField: (field: keyof ShortcutsConfig | undefined) => void;
}

async function generateQuickSmokeWav(): Promise<Buffer> {
  if (process.platform === 'win32') {
    const tmpRaw = path.join(os.tmpdir(), `wf-ui-smoke-${Date.now()}.wav`);
    const psScript = [
      'Add-Type -AssemblyName System.Speech',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      `$s.SetOutputToWaveFile('${tmpRaw.replace(/'/g, "''")}')`,
      "$s.Speak('Local GPU test number 42.')",
      '$s.Dispose()',
    ].join('; ');
    try {
      await execFileAsync('powershell', ['-NoProfile', '-Command', psScript], { timeout: 10000 });
      const fs = await import('node:fs');
      const raw = fs.readFileSync(tmpRaw);
      try { fs.unlinkSync(tmpRaw); } catch {}
      // Resample if ffmpeg is present, else parse/keep raw PCM
      const tmp16 = `${tmpRaw}.16k.wav`;
      try {
        fs.writeFileSync(tmpRaw, raw);
        await execFileAsync('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmpRaw, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', tmp16], { timeout: 5000 });
        const out = fs.readFileSync(tmp16);
        try { fs.unlinkSync(tmpRaw); } catch {}
        try { fs.unlinkSync(tmp16); } catch {}
        return out;
      } catch {
        try { fs.unlinkSync(tmpRaw); } catch {}
        return raw;
      }
    } catch {
      // Fallback silent tone WAV below
    }
  }
  const samples = new Int16Array(16000);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.round(800 * Math.sin((2 * Math.PI * 300 * i) / 16000));
  }
  return encodePcm16MonoWav(samples, 16000);
}

export function registerIpcHandlers(ctx: AppRuntimeContext): void {
  const sendToHub = <T>(channel: string, payload: T): void => {
    const hub = ctx.getHubWindow();
    if (hub && !hub.isDestroyed() && !hub.webContents.isDestroyed()) {
      hub.webContents.send(channel, payload);
    }
  };

  const broadcastSettingsUpdate = (settings: AppSettings): void => {
    sendToHub(IPC.EVENT_SETTINGS_CHANGED, settings);
    ctx.getTray()?.update({ settings });
    ctx.stateMachine.refreshIdleVisibility();
    const hud = ctx.getHudController();
    if (hud) {
      hud.reposition(settings.dockPosition);
      const hudState = ctx.stateMachine.getState();
      hud.setVisible(hudState !== 'hidden', settings.dockPosition);
    }
  };

  const applySettingsSideEffects = async (
    prev: AppSettings,
    next: AppSettings
  ): Promise<void> => {
    if (prev.launchAtLogin !== next.launchAtLogin) {
      try {
        app.setLoginItemSettings({
          openAtLogin: next.launchAtLogin,
          args: ['--hidden'],
        });
      } catch {
        // Not supported on some Linux DEs; systemd/autostart handles Linux
      }
    }

    if (JSON.stringify(prev.shortcuts) !== JSON.stringify(next.shortcuts)) {
      await ctx.platform.updateShortcuts(next.shortcuts);
    }

    if (
      prev.asrEngine !== next.asrEngine ||
      prev.gpuDeviceId !== next.gpuDeviceId ||
      prev.customCrispAsrPath !== next.customCrispAsrPath
    ) {
      if (prev.asrEngine !== next.asrEngine) {
        await ctx.switchAsrEngine(next.asrEngine, next);
      } else {
        void ctx
          .getAsr()
          .restart({
            gpuDeviceId: next.gpuDeviceId,
            customBinaryPath: next.customCrispAsrPath || undefined,
          })
          .catch(() => {});
      }
    }

    broadcastSettingsUpdate(next);
  };

  // ---- Settings ----
  ipcMain.handle(IPC.SETTINGS_GET, () => ctx.db.getSettings());

  ipcMain.handle(IPC.SETTINGS_UPDATE, async (_event, patch: Partial<AppSettings>) => {
    const prev = ctx.db.getSettings();
    const next = ctx.db.updateSettings(patch);
    await applySettingsSideEffects(prev, next);
    return next;
  });

  ipcMain.handle(
    IPC.SETTINGS_CAPTURE_SHORTCUT_START,
    async (_event, field?: keyof ShortcutsConfig) => {
      ctx.setCapturingShortcutField(field);
      await ctx.platform.startShortcutCapture();
    }
  );

  ipcMain.handle(IPC.SETTINGS_CAPTURE_SHORTCUT_STOP, async () => {
    ctx.setCapturingShortcutField(undefined);
    await ctx.platform.stopShortcutCapture();
  });

  // ---- Dictionary ----
  ipcMain.handle(IPC.DICTIONARY_LIST, () => ctx.db.listDictionary());
  ipcMain.handle(
    IPC.DICTIONARY_UPSERT,
    (_event, entry: Partial<DictionaryEntry> & { phrase: string }) =>
      ctx.db.upsertDictionary(entry)
  );
  ipcMain.handle(IPC.DICTIONARY_DELETE, (_event, id: string) => {
    ctx.db.deleteDictionary(id);
  });
  ipcMain.handle(IPC.DICTIONARY_SUGGESTIONS_LIST, () =>
    ctx.db.listDictionarySuggestions()
  );
  ipcMain.handle(IPC.DICTIONARY_SUGGESTIONS_ACCEPT, (_event, id: string) =>
    ctx.db.acceptDictionarySuggestion(id)
  );
  ipcMain.handle(IPC.DICTIONARY_SUGGESTIONS_DISMISS, (_event, id: string) => {
    ctx.db.dismissDictionarySuggestion(id);
  });

  // ---- Snippets ----
  ipcMain.handle(IPC.SNIPPETS_LIST, () => ctx.db.listSnippets());
  ipcMain.handle(
    IPC.SNIPPETS_UPSERT,
    (_event, entry: Partial<SnippetEntry> & { trigger: string; expansion: string }) =>
      ctx.db.upsertSnippet(entry)
  );
  ipcMain.handle(IPC.SNIPPETS_DELETE, (_event, id: string) => {
    ctx.db.deleteSnippet(id);
  });

  // ---- Regex Rules & Pipeline Test ----
  ipcMain.handle(IPC.REGEX_LIST, () => ctx.db.listRegexRules());
  ipcMain.handle(
    IPC.REGEX_UPSERT,
    (_event, entry: Partial<RegexRuleEntry> & { name: string; pattern: string }) =>
      ctx.db.upsertRegexRule(entry)
  );
  ipcMain.handle(IPC.REGEX_DELETE, (_event, id: string) => {
    ctx.db.deleteRegexRule(id);
  });
  ipcMain.handle(IPC.REGEX_REORDER, (_event, orderedIds: string[]) =>
    ctx.db.reorderRegexRules(orderedIds)
  );
  ipcMain.handle(IPC.PIPELINE_TEST, (_event, input: string, appName?: string) => {
    const settings = ctx.db.getSettings();
    return runTextPipeline(input, {
      dictionary: ctx.db.listDictionary(),
      snippets: ctx.db.listSnippets(),
      regexRules: ctx.db.listRegexRules(),
      cleanup: settings.cleanup,
      targetAppName: appName,
    });
  });

  // ---- History & Stats ----
  ipcMain.handle(IPC.HISTORY_LIST, (_event, query?: HistoryListQuery) =>
    ctx.db.listHistory(query)
  );
  ipcMain.handle(IPC.HISTORY_DELETE, (_event, id: string) => {
    ctx.db.deleteHistory(id);
  });
  ipcMain.handle(IPC.HISTORY_CLEAR, () => {
    ctx.db.clearHistory();
  });
  ipcMain.handle(IPC.HISTORY_PASTE_ENTRY, async (_event, id: string) => {
    const all = ctx.db.listHistory({ includeArchived: true });
    const entry = all.find((h) => h.id === id);
    if (!entry) return;
    const settings = ctx.db.getSettings();
    const fg = await ctx.platform.getForegroundApp().catch(() => ({
      processName: '',
      title: '',
      isTerminal: false,
    }));
    await ctx.platform.pasteText({
      text: entry.pastedText,
      restoreClipboard: settings.restoreClipboardAfterPaste,
      isTerminal: fg.isTerminal,
      terminalMode: settings.terminalPasteMode,
      linuxPasteBackend: settings.linuxPasteBackend,
    });
  });
  ipcMain.handle(IPC.HISTORY_COPY_ENTRY, async (_event, id: string) => {
    const all = ctx.db.listHistory({ includeArchived: true });
    const entry = all.find((h) => h.id === id);
    if (!entry) return;
    await ctx.platform.copyText(entry.pastedText);
  });
  ipcMain.handle(
    IPC.HISTORY_SET_CORRECTED_TEXT,
    (_event, id: string, correctedText: string | null) => {
      ctx.db.setHistoryCorrectedText(id, correctedText);
    }
  );
  ipcMain.handle(IPC.CORPUS_STATS, async () => {
    return ctx.corpusStore ? ctx.corpusStore.getStats() : null;
  });
  ipcMain.handle(IPC.CORPUS_EXPORT, async (_event, outputDir?: string) => {
    if (!ctx.corpusStore) return null;
    let targetDir = outputDir?.trim();
    if (!targetDir) {
      const hub = ctx.getHubWindow();
      const dialogOpts: Electron.OpenDialogOptions = {
        title: 'Export Speech Corpus for Colab',
        properties: ['openDirectory', 'createDirectory'],
      };
      const res =
        hub && !hub.isDestroyed()
          ? await dialog.showOpenDialog(hub, dialogOpts)
          : await dialog.showOpenDialog(dialogOpts);
      if (res.canceled || res.filePaths.length === 0) {
        return null;
      }
      targetDir = res.filePaths[0];
    }
    return ctx.corpusStore.exportColabDataset(targetDir);
  });
  ipcMain.handle(IPC.STATS_GET, () => computeUsageStats(ctx.db.listHistory({ includeArchived: true })));
  ipcMain.handle(IPC.TOKEN_STATS_GET, () =>
    getTokenUsageStats(ctx.db.listHistory({ includeArchived: true }))
  );

  // ---- Model & GPU ----
  ipcMain.handle(IPC.MODEL_STATUS, () => ctx.getAsr().getStatus());

  ipcMain.handle(IPC.MODEL_DOWNLOAD, async () => {
    const asr = ctx.getAsr();
    const current = asr.getStatus();
    sendToHub<ModelStatus>(IPC.EVENT_MODEL_STATUS, {
      ...current,
      state: 'downloading',
      errorMessage: undefined,
    });

    try {
      await downloadModelAndRuntime((progress) => {
        const snapshot: ModelStatus = {
          ...ctx.getAsr().getStatus(),
          state: 'downloading',
          downloadProgress: progress,
        };
        sendToHub(IPC.EVENT_MODEL_STATUS, snapshot);
      });
      const settings = ctx.db.getSettings();
      await ctx.getAsr().restart({
        gpuDeviceId: settings.gpuDeviceId,
        customBinaryPath: settings.customCrispAsrPath || undefined,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendToHub<ModelStatus>(IPC.EVENT_MODEL_STATUS, {
        ...ctx.getAsr().getStatus(),
        state: 'error',
        errorMessage: msg,
      });
    }
    return ctx.getAsr().getStatus();
  });

  ipcMain.handle(IPC.MODEL_RESTART, async () => {
    const settings = ctx.db.getSettings();
    try {
      await ctx.getAsr().restart({
        gpuDeviceId: settings.gpuDeviceId,
        customBinaryPath: settings.customCrispAsrPath || undefined,
      });
    } catch {
      // Status listener updates Hub with exact error
    }
    return ctx.getAsr().getStatus();
  });

  ipcMain.handle(IPC.MODEL_TEST_SMOKE, async (): Promise<SmokeTestResult> => {
    const asr = ctx.getAsr();
    if (asr.getStatus().state !== 'ready') {
      return { ok: false, error: 'Model server is not ready yet' };
    }
    try {
      const wavBuffer = await generateQuickSmokeWav();
      const settings = ctx.db.getSettings();
      const res = await asr.transcribe({
        wavBuffer,
        language: settings.language,
        rumble: settings.rumble,
      });
      return {
        ok: true,
        latencyMs: res.asrLatencyMs,
        text: res.rawText || '(empty audio / silence)',
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // ---- Sounds ----
  ipcMain.handle(IPC.SOUNDS_LIST_STATUS, () => {
    const settings = ctx.db.getSettings();
    return ctx.soundResolver.listStatuses(settings.customSoundDir);
  });

  ipcMain.handle(IPC.SOUNDS_BROWSE_DIR, async () => {
    const hub = ctx.getHubWindow();
    const dialogOpts: Electron.OpenDialogOptions = {
      title: 'Select Custom Notification Sounds Folder',
      properties: ['openDirectory'],
    };
    const res =
      hub && !hub.isDestroyed()
        ? await dialog.showOpenDialog(hub, dialogOpts)
        : await dialog.showOpenDialog(dialogOpts);
    if (res.canceled || res.filePaths.length === 0) {
      return null;
    }
    return res.filePaths[0];
  });

  ipcMain.handle(IPC.SOUNDS_PLAY_PREVIEW, (_event, slot: SoundSlot) => {
    ctx.playSoundOnWindow('hub', slot);
  });

  // ---- Omarchy & Linux ----
  ipcMain.handle(IPC.OMARCHY_STATUS, () => ctx.platform.getOmarchyEnvironment());

  ipcMain.handle(IPC.OMARCHY_APPLY, async () => {
    if (ctx.platform.applyOmarchySetup) {
      const env = await ctx.platform.applyOmarchySetup();
      ctx.setLatestPalette(env.palette);
      sendToHub(IPC.EVENT_OMARCHY_PALETTE, env.palette);
      return env;
    }
    return ctx.platform.getOmarchyEnvironment();
  });

  ipcMain.handle(IPC.OMARCHY_REMOVE, async () => {
    if (ctx.platform.removeOmarchySetup) {
      return ctx.platform.removeOmarchySetup();
    }
    return ctx.platform.getOmarchyEnvironment();
  });

  ipcMain.handle(IPC.OMARCHY_REFRESH, async () => {
    const env = await ctx.platform.getOmarchyEnvironment();
    ctx.setLatestPalette(env.palette);
    sendToHub(IPC.EVENT_OMARCHY_PALETTE, env.palette);
    return env;
  });

  // ---- Audio Devices ----
  ipcMain.handle(IPC.AUDIO_DEVICES_SET, (_event, devices: AudioDeviceOption[]) => {
    ctx.setAudioDevices(devices);
    ctx.getTray()?.update({ devices });
  });

  ipcMain.handle(IPC.AUDIO_DEVICES_GET, () => ctx.getAudioDevices());

  // ---- HUD ----
  ipcMain.handle(IPC.HUD_GET_STATE, () => ({
    ...ctx.stateMachine.getCurrentPayload(),
    palette: ctx.getLatestPalette(),
  }));

  ipcMain.handle(IPC.HUD_MOUSE_ENTER, () => {
    ctx.getHudController()?.setInteractive(true);
    ctx.stateMachine.setHovering(true);
  });

  ipcMain.handle(IPC.HUD_MOUSE_LEAVE, () => {
    ctx.stateMachine.setHovering(false);
    ctx.getHudController()?.setInteractive(false);
  });

  ipcMain.handle(IPC.HUD_ACTION, async (_event, action: HudActionPayload) => {
    switch (action.type) {
      case 'click-toggle':
        await ctx.stateMachine.handleHandsFreeToggle();
        break;
      case 'stop':
        await ctx.stateMachine.handleHandsFreeToggle();
        break;
      case 'cancel':
        await ctx.stateMachine.handleCancel();
        break;
      case 'paste-last':
        await ctx.stateMachine.handlePasteLast();
        break;
      case 'open-hub': {
        const hub = ctx.getHubWindow();
        showAndFocusHub(hub);
        if (process.platform === 'win32' && hub && !hub.isDestroyed()) {
          try {
            const buf = hub.getNativeWindowHandle();
            const hwnd =
              buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
            void ctx.platform.focusNativeWindow?.(hwnd);
          } catch {
            // Non-fatal
          }
        }
        break;
      }
      case 'open-shortcuts': {
        const hub = ctx.getHubWindow();
        showAndFocusHub(hub);
        if (process.platform === 'win32' && hub && !hub.isDestroyed()) {
          try {
            const buf = hub.getNativeWindowHandle();
            const hwnd =
              buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
            void ctx.platform.focusNativeWindow?.(hwnd);
          } catch {
            // Non-fatal
          }
        }
        const target: { page: HubPage; settingsTab: SettingsTab } = {
          page: 'settings',
          settingsTab: 'general',
        };
        sendToHub(IPC.EVENT_NAVIGATE, target);
        break;
      }
      case 'set-dock':
        if (action.value === 'bottom' || action.value === 'left' || action.value === 'right') {
          const prev = ctx.db.getSettings();
          const next = ctx.db.updateSettings({ dockPosition: action.value as DockPosition });
          await applySettingsSideEffects(prev, next);
        }
        break;
      case 'toggle-hide': {
        const prev = ctx.db.getSettings();
        const next = ctx.db.updateSettings({ hideFlowBarWhenIdle: !prev.hideFlowBarWhenIdle });
        await applySettingsSideEffects(prev, next);
        break;
      }
      case 'set-mic':
        if (typeof action.value === 'string') {
          const prev = ctx.db.getSettings();
          const next = ctx.db.updateSettings({ microphoneDeviceId: action.value });
          await applySettingsSideEffects(prev, next);
        }
        break;
      case 'set-mic-profile':
        if (action.value === 'quiet' || action.value === 'noisy') {
          const prev = ctx.db.getSettings();
          const next = ctx.db.updateSettings({ micProfile: action.value as MicProfile });
          await applySettingsSideEffects(prev, next);
        }
        break;
      case 'set-language':
        if (typeof action.value === 'string') {
          const prev = ctx.db.getSettings();
          const next = ctx.db.updateSettings({ language: action.value });
          await applySettingsSideEffects(prev, next);
        }
        break;
    }
  });

  ipcMain.handle(IPC.HUD_AUDIO_SUBMIT, async (_event, payload: HudAudioSubmitPayload) => {
    const wavBuffer = Buffer.from(payload.wavBuffer);
    const opusBuffer =
      payload.opusBuffer && payload.opusBuffer.byteLength > 0
        ? Buffer.from(payload.opusBuffer)
        : undefined;
    const stats = wavBuffer.length >= 44 ? computeWavStats(wavBuffer) : null;
    const isSilent =
      Boolean(payload.error) ||
      wavBuffer.length === 0 ||
      payload.peakLevel === 0 ||
      Boolean(stats?.isSilent);

    await ctx.stateMachine.handleAudioSubmitted({
      sessionId: payload.sessionId,
      wavBuffer,
      opusBuffer,
      speechDurationMs: payload.speechDurationMs || stats?.durationMs || 0,
      totalDurationMs: payload.durationMs || stats?.durationMs || 0,
      isSilent,
      error: payload.error,
    });
  });

  ipcMain.handle(IPC.HUD_CONTEXT_MENU, () => {
    const hudWin = ctx.getHudController()?.window;
    const settings = ctx.db.getSettings();
    const devices = ctx.getAudioDevices();
    const latest = ctx.db.getLatestHistory();
    const topLangs = ['auto', 'English', 'Hindi', 'Spanish', 'French', 'German', 'Japanese'];

    const menu = Menu.buildFromTemplate([
      {
        label: 'Start / Stop Hands-Free',
        click: () => void ctx.stateMachine.handleHandsFreeToggle(),
      },
      {
        label: 'Paste last transcript',
        enabled: Boolean(latest),
        click: () => void ctx.stateMachine.handlePasteLast(),
      },
      { type: 'separator' },
      {
        label: 'Microphone',
        submenu: [
          {
            label: 'System Default',
            type: 'radio',
            checked: settings.microphoneDeviceId === 'default',
            click: () => {
              const prev = ctx.db.getSettings();
              const next = ctx.db.updateSettings({ microphoneDeviceId: 'default' });
              void applySettingsSideEffects(prev, next);
            },
          },
          ...devices
            .filter((d) => d.id !== 'default')
            .map((d) => ({
              label: d.label || d.id,
              type: 'radio' as const,
              checked: settings.microphoneDeviceId === d.id,
              click: () => {
                const prev = ctx.db.getSettings();
                const next = ctx.db.updateSettings({ microphoneDeviceId: d.id });
                void applySettingsSideEffects(prev, next);
              },
            })),
        ],
      },
      {
        label: 'Mic Environment',
        submenu: (
          [
            { value: 'quiet' as MicProfile, label: 'Quiet Room (Whisper)' },
            { value: 'noisy' as MicProfile, label: 'Outside (Noisy)' },
          ] as const
        ).map((item) => ({
          label: item.label,
          type: 'radio' as const,
          checked: settings.micProfile === item.value,
          click: () => {
            const prev = ctx.db.getSettings();
            const next = ctx.db.updateSettings({ micProfile: item.value });
            void applySettingsSideEffects(prev, next);
          },
        })),
      },
      {
        label: 'Language',
        submenu: topLangs.map((key) => {
          const entry = RUMBLE_LANGUAGES.find((l) => l.code === key || l.name === key);
          const value = entry?.code === 'auto' ? 'auto' : entry?.name || key;
          return {
            label: entry?.name || key,
            type: 'radio' as const,
            checked: settings.language === value || settings.language === key,
            click: () => {
              const prev = ctx.db.getSettings();
              const next = ctx.db.updateSettings({ language: value });
              void applySettingsSideEffects(prev, next);
            },
          };
        }),
      },
      {
        label: 'Dock Position',
        submenu: (['bottom', 'left', 'right'] as DockPosition[]).map((pos) => ({
          label: pos[0].toUpperCase() + pos.slice(1),
          type: 'radio' as const,
          checked: settings.dockPosition === pos,
          click: () => {
            const prev = ctx.db.getSettings();
            const next = ctx.db.updateSettings({ dockPosition: pos });
            void applySettingsSideEffects(prev, next);
          },
        })),
      },
      {
        label: settings.hideFlowBarWhenIdle ? 'Show Flow Bar when idle' : 'Hide Flow Bar when idle',
        click: () => {
          const prev = ctx.db.getSettings();
          const next = ctx.db.updateSettings({ hideFlowBarWhenIdle: !prev.hideFlowBarWhenIdle });
          void applySettingsSideEffects(prev, next);
        },
      },
      { type: 'separator' },
      {
        label: 'Open Dashboard & Settings',
        click: () => showAndFocusHub(ctx.getHubWindow()),
      },
    ]);

    menu.popup({ window: hudWin && !hudWin.isDestroyed() ? hudWin : undefined });
  });
}
