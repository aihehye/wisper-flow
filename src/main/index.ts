import { app, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { IPC } from '../shared/ipcChannels';
import type {
  AppSettings,
  AudioDeviceOption,
  GpuDeviceInfo,
  ModelStatus,
  OmarchyPalette,
  ShortcutsConfig,
  SoundSlot,
} from '../shared/types';
import { CrispAsrBackend } from './asr/crispAsrBackend';
import { LlamaServerBackend } from './asr/llamaServerBackend';
import type { AsrBackend, TranscribeRequest, TranscribeResult } from './asr/types';
import { registerIpcHandlers } from './ipcHandlers';
import { createPlatformBridge } from './platform';
import { applyOmarchySetup } from './platform/omarchy';
import type { PlatformBridge } from './platform/types';
import { SoundResolver } from './sounds/soundResolver';
import { DictationStateMachine } from './stateMachine';
import { CorpusStore } from './storage/corpusStore';
import { AppDatabase } from './storage/db';
import { AppTrayController } from './tray';
import { createHubWindow, showAndFocusHub } from './windows/hubWindow';
import { createHudWindow, type HudWindowController } from './windows/hudWindow';

const argv = process.argv.slice(1);
const isSetupOmarchyCli = argv.includes('--setup-omarchy') || argv.includes('setup-omarchy');
const isSmokeBoot = argv.includes('--smoke-boot');
const startHidden = argv.includes('--hidden');

class SwitchableAsrProxy implements AsrBackend {
  private active: AsrBackend;
  private unsubActive: (() => void) | null = null;
  private readonly listeners = new Set<(status: ModelStatus) => void>();

  constructor(initialEngine: 'llama-server' | 'crispasr') {
    this.active = this.createEngine(initialEngine);
    this.attachActive();
  }

  get id(): 'llama-server' | 'crispasr' {
    return this.active.id;
  }

  private createEngine(engine: 'llama-server' | 'crispasr'): AsrBackend {
    return engine === 'crispasr' ? new CrispAsrBackend() : new LlamaServerBackend();
  }

  private attachActive(): void {
    if (this.unsubActive) {
      this.unsubActive();
      this.unsubActive = null;
    }
    this.unsubActive = this.active.onStatusChange((status) => {
      for (const cb of this.listeners) {
        try {
          cb(status);
        } catch {
          // Ignore listener error
        }
      }
    });
  }

  async switchEngine(
    engine: 'llama-server' | 'crispasr',
    options: { gpuDeviceId: string; customBinaryPath?: string }
  ): Promise<void> {
    if (this.active.id === engine) {
      await this.active.restart(options);
      return;
    }
    await this.active.stop();
    this.active = this.createEngine(engine);
    this.attachActive();
    for (const cb of this.listeners) {
      try {
        cb(this.active.getStatus());
      } catch {
        // Ignore
      }
    }
    await this.active.start(options);
  }

  start(options: { gpuDeviceId: string; customBinaryPath?: string }): Promise<void> {
    return this.active.start(options);
  }

  stop(): Promise<void> {
    return this.active.stop();
  }

  restart(options: { gpuDeviceId: string; customBinaryPath?: string }): Promise<void> {
    return this.active.restart(options);
  }

  listDevices(): Promise<GpuDeviceInfo[]> {
    return this.active.listDevices();
  }

  getStatus(): ModelStatus {
    return this.active.getStatus();
  }

  transcribe(req: TranscribeRequest): Promise<TranscribeResult> {
    return this.active.transcribe(req);
  }

  onStatusChange(cb: (status: ModelStatus) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
}

function resolveProjectDir(): string {
  const candidates = [
    app.getAppPath(),
    path.resolve(__dirname, '../..'),
    process.cwd(),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'assets', 'sounds'))) {
      return dir;
    }
  }
  return app.getAppPath();
}

async function runSetupOmarchyAndExit(): Promise<void> {
  try {
    const env = await applyOmarchySetup();
    console.log(
      JSON.stringify(
        {
          ok: true,
          omarchyVersion: env.omarchyVersion,
          bindingsFile: env.bindingsFile,
          windowRulesFile: env.windowRulesFile,
          bindingsInstalled: env.bindingsInstalled,
          windowRulesInstalled: env.windowRulesInstalled,
          themeHookInstalled: env.themeHookInstalled,
        },
        null,
        2
      )
    );
    app.exit(0);
  } catch (err) {
    console.error('Failed to apply Omarchy setup:', err);
    app.exit(1);
  }
}

const ACTIVATE_PIPE_PATH =
  process.platform === 'win32'
    ? '\\\\.\\pipe\\wisper-flow-local-activate'
    : path.join(app.getPath('temp'), 'wisper-flow-local-activate.sock');

function notifyPrimaryInstanceToShowHub(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    const timer = setTimeout(done, 800);
    try {
      const client = net.createConnection(ACTIVATE_PIPE_PATH, () => {
        client.write('show-hub\n');
      });
      client.on('data', () => {
        clearTimeout(timer);
        client.end();
        done();
      });
      client.on('error', () => {
        clearTimeout(timer);
        done();
      });
      client.on('close', () => {
        clearTimeout(timer);
        done();
      });
    } catch {
      clearTimeout(timer);
      done();
    }
  });
}

if (isSetupOmarchyCli) {
  app.whenReady().then(() => void runSetupOmarchyAndExit());
} else {
  if (process.platform === 'linux' && typeof (app as unknown as { setDesktopName?: (n: string) => void }).setDesktopName === 'function') {
    (app as unknown as { setDesktopName: (n: string) => void }).setDesktopName('wisper-flow.desktop');
  }

  const gotLock = isSmokeBoot ? true : app.requestSingleInstanceLock();
  if (!gotLock) {
    void notifyPrimaryInstanceToShowHub().finally(() => {
      app.exit(0);
    });
  } else {
    void bootstrap();
  }
}

async function bootstrap(): Promise<void> {
  let hubWindow: BrowserWindow | null = null;
  let hudController: HudWindowController | null = null;
  let tray: AppTrayController | null = null;
  let db: AppDatabase | null = null;
  let platform: PlatformBridge | null = null;
  let asrProxy: SwitchableAsrProxy | null = null;
  let stateMachine: DictationStateMachine | null = null;
  let activateServer: net.Server | null = null;
  let isQuitting = false;
  let cleanupStarted = false;

  const bringHubToFront = (): void => {
    if (!hubWindow || hubWindow.isDestroyed()) {
      if (!isSmokeBoot && db) {
        const rootDirNow = resolveProjectDir();
        const devUrl = process.env.VITE_DEV_SERVER_URL?.replace(/\/$/, '');
        const iconsDirNow = path.join(rootDirNow, 'assets', 'icons');
        hubWindow = createHubWindow({
          preloadPath: path.join(rootDirNow, 'dist', 'preload', 'hubPreload.js'),
          rendererUrl: devUrl,
          rendererHtmlPath: path.join(rootDirNow, 'dist', 'renderer', 'index.html'),
          iconPath:
            process.platform === 'win32'
              ? path.join(iconsDirNow, 'app.ico')
              : path.join(iconsDirNow, 'app.png'),
          startHidden: false,
          isQuitting: () => isQuitting,
        });
      }
    }
    showAndFocusHub(hubWindow);
    if (process.platform === 'win32' && hubWindow && !hubWindow.isDestroyed()) {
      try {
        const buf = hubWindow.getNativeWindowHandle();
        const hwnd =
          buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
        void platform?.focusNativeWindow?.(hwnd);
      } catch {
        // Non-fatal
      }
    }
  };

  app.on('second-instance', () => {
    bringHubToFront();
  });

  if (!isSmokeBoot) {
    try {
      if (process.platform !== 'win32' && fs.existsSync(ACTIVATE_PIPE_PATH)) {
        fs.unlinkSync(ACTIVATE_PIPE_PATH);
      }
      activateServer = net.createServer((socket) => {
        socket.on('data', (chunk) => {
          const msg = chunk.toString('utf8').trim();
          if (msg.includes('show-hub')) {
            bringHubToFront();
            try {
              socket.write('ok\n');
            } catch {
              // Ignore
            }
          }
          socket.end();
        });
      });
      activateServer.on('error', () => {
        // Non-fatal
      });
      activateServer.listen(ACTIVATE_PIPE_PATH);
    } catch {
      // Non-fatal
    }
  }

  await app.whenReady();

  const rootDir = resolveProjectDir();
  const dbPath = isSmokeBoot
    ? path.join(app.getPath('userData'), 'flow-smoke.sqlite')
    : path.join(app.getPath('userData'), 'flow.sqlite');
  db = new AppDatabase(dbPath);
  const corpusStore = new CorpusStore(app.getPath('userData'), db);
  const initialSettings = db.getSettings();

  const bundledSoundsDir = path.join(rootDir, 'assets', 'sounds');
  const soundResolver = new SoundResolver(bundledSoundsDir, initialSettings.customSoundDir);
  const iconsDir = path.join(rootDir, 'assets', 'icons');
  const appIconPath =
    process.platform === 'win32'
      ? path.join(iconsDir, 'app.ico')
      : path.join(iconsDir, 'app.png');
  const trayIdleIcon = path.join(iconsDir, 'tray.png');
  const trayActiveIcon = path.join(iconsDir, 'tray-active.png');

  platform = createPlatformBridge();
  asrProxy = new SwitchableAsrProxy(initialSettings.asrEngine);

  let audioDevices: AudioDeviceOption[] = [{ id: 'default', label: 'System Default Microphone' }];
  let latestPalette: OmarchyPalette | null = null;
  let capturingField: keyof ShortcutsConfig | undefined;

  try {
    const env = await platform.getOmarchyEnvironment();
    latestPalette = env.palette;
  } catch {
    // Non-fatal
  }

  const playSoundOnWindow = (target: 'hud' | 'hub', slot: SoundSlot): void => {
    const settings = db!.getSettings();
    if (!settings.enableSounds && target === 'hud') return;
    const dataUrl = soundResolver.getSlotDataUrl(slot, settings.customSoundDir);
    if (!dataUrl) return;
    const win = target === 'hud' ? hudController?.window : hubWindow;
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(IPC.EVENT_PLAY_SOUND, { slot, dataUrl });
    }
  };

  stateMachine = new DictationStateMachine({
    getSettings: () => db!.getSettings(),
    platform,
    asr: asrProxy,
    db,
    corpusStore,
    sendHudState: (payload) => {
      const enriched = { ...payload, palette: latestPalette };
      const settings = db!.getSettings();
      if (hudController) {
        const shouldShow = enriched.state !== 'hidden';
        hudController.setVisible(shouldShow, settings.dockPosition);
        if (!hudController.window.isDestroyed() && !hudController.window.webContents.isDestroyed()) {
          hudController.window.webContents.send(IPC.EVENT_HUD_STATE, enriched);
        }
      }
      tray?.update({
        isListening: enriched.state === 'active_ptt' || enriched.state === 'active_popo',
      });
    },
    sendRecordCommand: (cmd) => {
      const hudWin = hudController?.window;
      if (hudWin && !hudWin.isDestroyed() && !hudWin.webContents.isDestroyed()) {
        hudWin.webContents.send(IPC.EVENT_RECORD_CMD, cmd);
      }
    },
    playSound: (slot) => {
      playSoundOnWindow('hud', slot);
    },
    onHistoryAdded: (entry) => {
      if (hubWindow && !hubWindow.isDestroyed() && !hubWindow.webContents.isDestroyed()) {
        hubWindow.webContents.send(IPC.EVENT_HISTORY_ADDED, entry);
      }
      tray?.update({ latestHistory: entry });
    },
    onSuggestionsUpdated: () => {
      if (hubWindow && !hubWindow.isDestroyed() && !hubWindow.webContents.isDestroyed()) {
        hubWindow.webContents.send(IPC.DICTIONARY_SUGGESTIONS_UPDATED);
      }
    },
    getExtraExcludePids: () =>
      app
        .getAppMetrics()
        .map((m) => m.pid)
        .filter((pid) => Number.isInteger(pid) && pid > 0),
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL?.replace(/\/$/, '');
  const hubPreloadPath = path.join(rootDir, 'dist', 'preload', 'hubPreload.js');
  const hudPreloadPath = path.join(rootDir, 'dist', 'preload', 'hudPreload.js');
  const hubHtmlPath = path.join(rootDir, 'dist', 'renderer', 'index.html');
  const hudHtmlPath = path.join(rootDir, 'dist', 'renderer', 'hud.html');

  hubWindow = createHubWindow({
    preloadPath: hubPreloadPath,
    rendererUrl: devServerUrl,
    rendererHtmlPath: hubHtmlPath,
    iconPath: appIconPath,
    startHidden: startHidden || isSmokeBoot,
    isQuitting: () => isQuitting,
  });

  hudController = createHudWindow({
    preloadPath: hudPreloadPath,
    rendererUrl: devServerUrl,
    rendererHtmlPath: hudHtmlPath,
    dockPosition: initialSettings.dockPosition,
    initiallyHidden: initialSettings.hideFlowBarWhenIdle || isSmokeBoot,
  });

  tray = new AppTrayController({
    idleIconPath: trayIdleIcon,
    activeIconPath: trayActiveIcon,
    settings: initialSettings,
    latestHistory: db.getLatestHistory(),
    callbacks: {
      onOpenHub: () => bringHubToFront(),
      onOpenShortcuts: () => {
        bringHubToFront();
        hubWindow?.webContents.send(IPC.EVENT_NAVIGATE, {
          page: 'settings',
          settingsTab: 'general',
        });
      },
      onPasteLast: () => void stateMachine?.handlePasteLast(),
      onCopyLast: () => void stateMachine?.handleCopyLast(),
      onSelectMic: (deviceId) => {
        const next = db!.updateSettings({ microphoneDeviceId: deviceId });
        hubWindow?.webContents.send(IPC.EVENT_SETTINGS_CHANGED, next);
        tray?.update({ settings: next });
        stateMachine?.refreshIdleVisibility();
      },
      onSelectMicProfile: (micProfile) => {
        const next = db!.updateSettings({ micProfile });
        hubWindow?.webContents.send(IPC.EVENT_SETTINGS_CHANGED, next);
        tray?.update({ settings: next });
        stateMachine?.refreshIdleVisibility();
      },
      onSelectLanguage: (language) => {
        const next = db!.updateSettings({ language });
        hubWindow?.webContents.send(IPC.EVENT_SETTINGS_CHANGED, next);
        tray?.update({ settings: next });
      },
      onToggleFlowBar: () => {
        const prev = db!.getSettings();
        const next = db!.updateSettings({ hideFlowBarWhenIdle: !prev.hideFlowBarWhenIdle });
        hubWindow?.webContents.send(IPC.EVENT_SETTINGS_CHANGED, next);
        tray?.update({ settings: next });
        stateMachine?.refreshIdleVisibility();
        hudController?.setVisible(
          stateMachine?.getState() !== 'hidden',
          next.dockPosition
        );
      },
      onQuit: () => {
        isQuitting = true;
        app.quit();
      },
    },
  });

  registerIpcHandlers({
    db,
    corpusStore,
    platform,
    getAsr: () => asrProxy!,
    switchAsrEngine: async (engine, settings) => {
      await asrProxy!.switchEngine(engine, {
        gpuDeviceId: settings.gpuDeviceId,
        customBinaryPath: settings.customCrispAsrPath || undefined,
      });
    },
    stateMachine,
    soundResolver,
    getHubWindow: () => hubWindow,
    getHudController: () => hudController,
    getTray: () => tray,
    getAudioDevices: () => audioDevices,
    setAudioDevices: (devices) => {
      audioDevices = devices;
    },
    getLatestPalette: () => latestPalette,
    setLatestPalette: (palette) => {
      latestPalette = palette;
    },
    playSoundOnWindow,
    setCapturingShortcutField: (field) => {
      capturingField = field;
    },
  });

  asrProxy.onStatusChange((status) => {
    if (hubWindow && !hubWindow.isDestroyed() && !hubWindow.webContents.isDestroyed()) {
      hubWindow.webContents.send(IPC.EVENT_MODEL_STATUS, status);
    }
  });

  const shutdown = async (): Promise<void> => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    isQuitting = true;
    stateMachine?.dispose();
    await Promise.allSettled([
      platform?.stop() ?? Promise.resolve(),
      asrProxy?.stop() ?? Promise.resolve(),
    ]);
    try {
      activateServer?.close();
      activateServer = null;
      if (process.platform !== 'win32' && fs.existsSync(ACTIVATE_PIPE_PATH)) {
        fs.unlinkSync(ACTIVATE_PIPE_PATH);
      }
    } catch {
      // Ignore
    }
    try {
      tray?.destroy();
    } catch {
      // Ignore
    }
    try {
      db?.close();
    } catch {
      // Ignore
    }
  };

  app.on('before-quit', (e) => {
    if (!cleanupStarted) {
      e.preventDefault();
      void shutdown().finally(() => {
        app.exit(0);
      });
    }
  });

  const onSignal = () => {
    void shutdown().finally(() => {
      app.exit(0);
    });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  // Start platform hooks / Unix socket
  try {
    await platform.start(
      {
        onPttDown: () => void stateMachine?.handlePttDown(),
        onPttUp: () => void stateMachine?.handlePttUp(),
        onPttOtherKey: () => void stateMachine?.handlePttOtherKey(),
        onHandsFreePressed: () => void stateMachine?.handleHandsFreeToggle(),
        onCancelPressed: () => void stateMachine?.handleCancel(),
        onPasteLastPressed: () => void stateMachine?.handlePasteLast(),
        onCopyLastPressed: () => void stateMachine?.handleCopyLast(),
        onDirectPttStart: () => void stateMachine?.handleDirectPttStart(),
        onDirectPttStop: () => void stateMachine?.handleDirectPttStop(),
        onDirectToggle: () => void stateMachine?.handleHandsFreeToggle(),
        onShowHub: () => bringHubToFront(),
        onToggleHud: () => {
          const prev = db!.getSettings();
          const next = db!.updateSettings({ hideFlowBarWhenIdle: !prev.hideFlowBarWhenIdle });
          hubWindow?.webContents.send(IPC.EVENT_SETTINGS_CHANGED, next);
          tray?.update({ settings: next });
          stateMachine?.refreshIdleVisibility();
        },
        onReloadTheme: () => {
          void platform?.getOmarchyEnvironment().then((env) => {
            latestPalette = env.palette;
            hubWindow?.webContents.send(IPC.EVENT_OMARCHY_PALETTE, env.palette);
            if (stateMachine) {
              hudController?.window.webContents.send(IPC.EVENT_HUD_STATE, {
                ...stateMachine.getCurrentPayload(),
                palette: latestPalette,
              });
            }
          });
        },
        onPaletteChanged: (palette) => {
          latestPalette = palette;
          hubWindow?.webContents.send(IPC.EVENT_OMARCHY_PALETTE, palette);
          if (stateMachine) {
            hudController?.window.webContents.send(IPC.EVENT_HUD_STATE, {
              ...stateMachine.getCurrentPayload(),
              palette: latestPalette,
            });
          }
        },
        onShortcutCaptured: (shortcut) => {
          const payload = capturingField ? { field: capturingField, shortcut } : shortcut;
          capturingField = undefined;
          hubWindow?.webContents.send(IPC.EVENT_SHORTCUT_CAPTURED, payload);
        },
      },
      initialSettings.shortcuts
    );
  } catch (err) {
    console.error('[Main] PlatformBridge start error:', err);
  }

  // Start local GPU ASR server cleanly in background (or await if smoke-boot)
  const asrStartPromise = asrProxy
    .start({
      gpuDeviceId: initialSettings.gpuDeviceId,
      customBinaryPath: initialSettings.customCrispAsrPath || undefined,
    })
    .catch((err) => {
      console.warn('[Main] ASR startup warning:', err instanceof Error ? err.message : err);
    });

  if (isSmokeBoot) {
    await runSmokeBootCheck({
      hubWindow,
      hudWindow: hudController.window,
      asrProxy,
      asrStartPromise,
      platform,
      shutdown,
    });
  }
}

async function runSmokeBootCheck(opts: {
  hubWindow: BrowserWindow;
  hudWindow: BrowserWindow;
  asrProxy: SwitchableAsrProxy;
  asrStartPromise: Promise<void>;
  platform: PlatformBridge;
  shutdown: () => Promise<void>;
}): Promise<void> {
  const consoleErrors: string[] = [];

  const trackErrors = (win: BrowserWindow, label: string) => {
    win.webContents.on('console-message', (details) => {
      if (details.level === 'error') {
        consoleErrors.push(`${label}: ${details.message}`);
      }
    });
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      consoleErrors.push(`${label}: did-fail-load (${code}) ${desc}`);
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      consoleErrors.push(`${label}: render-process-gone (${details.reason})`);
    });
  };

  trackErrors(opts.hubWindow, 'hub');
  trackErrors(opts.hudWindow, 'hud');

  const waitLoaded = (win: BrowserWindow) =>
    new Promise<void>((resolve) => {
      if (!win.webContents.isLoading()) {
        resolve();
      } else {
        win.webContents.once('did-finish-load', () => resolve());
      }
    });

  await Promise.all([waitLoaded(opts.hubWindow), waitLoaded(opts.hudWindow), opts.asrStartPromise]);

  // Give React mount 300ms to render and catch any early mount exceptions
  await new Promise((r) => setTimeout(r, 300));

  const status = opts.asrProxy.getStatus();
  const fg = await opts.platform.getForegroundApp().catch(() => ({
    processName: '',
    title: '',
    isTerminal: false,
  }));

  let transcriptionTest: { ok: boolean; text?: string; latencyMs?: number; error?: string } = {
    ok: false,
    error: 'ASR not ready',
  };
  if (status.state === 'ready') {
    try {
      const wav = await generateQuickSmokeSpeech();
      const res = await opts.asrProxy.transcribe({
        wavBuffer: wav,
        language: 'English',
        rumble: { digits: true, filler: false, verbatim: true },
      });
      transcriptionTest = { ok: true, text: res.rawText, latencyMs: res.asrLatencyMs };
    } catch (err) {
      transcriptionTest = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const report = {
    hubLoaded: !opts.hubWindow.isDestroyed(),
    hudLoaded: !opts.hudWindow.isDestroyed(),
    asrState: status.state,
    activeDeviceId: status.activeDeviceId,
    activeDeviceName: status.activeDeviceName,
    helperPids: opts.platform.getHelperPids(),
    foregroundApp: fg,
    transcriptionTest,
    consoleErrors,
  };

  console.log('SMOKE_BOOT_RESULT ' + JSON.stringify(report));

  const exitOk =
    status.state === 'ready' &&
    transcriptionTest.ok &&
    consoleErrors.length === 0 &&
    (process.platform !== 'win32' || report.helperPids.length > 0);

  await opts.shutdown();
  app.exit(exitOk ? 0 : 1);
}

async function generateQuickSmokeSpeech(): Promise<Buffer> {
  const { encodePcm16MonoWav } = await import('./asr/wavUtils');
  if (process.platform === 'win32') {
    const osMod = await import('node:os');
    const cp = await import('node:child_process');
    const util = await import('node:util');
    const execAsync = util.promisify(cp.execFile);
    const tmpRaw = path.join(osMod.tmpdir(), `wf-boot-${Date.now()}.wav`);
    const tmp16 = path.join(osMod.tmpdir(), `wf-boot-16-${Date.now()}.wav`);
    try {
      await execAsync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${tmpRaw.replace(/'/g, "''")}'); $s.Speak('Smoke boot passed on RTX graphics.'); $s.Dispose()`,
        ],
        { timeout: 10000 }
      );
      await execAsync(
        'ffmpeg',
        ['-y', '-loglevel', 'error', '-i', tmpRaw, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', tmp16],
        { timeout: 5000 }
      );
      const buf = fs.readFileSync(tmp16);
      try { fs.unlinkSync(tmpRaw); } catch {}
      try { fs.unlinkSync(tmp16); } catch {}
      return buf;
    } catch {
      try { fs.unlinkSync(tmpRaw); } catch {}
      try { fs.unlinkSync(tmp16); } catch {}
    }
  }
  const samples = new Int16Array(16000);
  return encodePcm16MonoWav(samples, 16000);
}
