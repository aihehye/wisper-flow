import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { OmarchyEnvironment, ShortcutsConfig } from '../../shared/types';
import { generateOmarchySnippets } from './omarchy';
import type {
  ForegroundAppInfo,
  PlatformBridge,
  PlatformEventHandlers,
  PlatformPasteOptions,
} from './types';

interface HelperMessage {
  event?: string;
  id?: number;
  pid?: number;
  ok?: boolean;
  error?: string;
  message?: string;
  vk?: number | string;
  shortcut?: string;
  processName?: string;
  title?: string;
  isTerminal?: boolean;
}

interface PendingRequest {
  resolve: (msg: HelperMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WindowsBridge implements PlatformBridge {
  readonly kind = 'win32' as const;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private helperPid: number | null = null;
  private handlers: PlatformEventHandlers | null = null;
  private currentShortcuts: ShortcutsConfig | null = null;
  private stdoutBuffer = '';
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private stopping = false;
  private restartedOnce = false;

  private resolveHelperPath(): string {
    const appPath = typeof app?.getAppPath === 'function' ? app.getAppPath() : process.cwd();
    const candidates = [
      process.resourcesPath
        ? path.join(process.resourcesPath, 'win-helper', 'wisper-win-helper.exe')
        : '',
      path.resolve(appPath, 'native/win-helper/wisper-win-helper.exe'),
      path.resolve(__dirname, '../../native/win-helper/wisper-win-helper.exe'),
      path.resolve(__dirname, '../../../native/win-helper/wisper-win-helper.exe'),
      path.resolve(process.cwd(), 'native/win-helper/wisper-win-helper.exe'),
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    throw new Error(
      `wisper-win-helper.exe not found. Checked: ${candidates.join(', ')}. Run "npm run build:win-helper".`
    );
  }

  async start(handlers: PlatformEventHandlers, shortcuts: ShortcutsConfig): Promise<void> {
    this.handlers = handlers;
    this.currentShortcuts = { ...shortcuts };
    this.stopping = false;
    this.restartedOnce = false;

    await this.spawnHelper();
    await this.updateShortcuts(shortcuts);
  }

  private async spawnHelper(): Promise<void> {
    const exePath = this.resolveHelperPath();
    this.stdoutBuffer = '';

    await new Promise<void>((resolveReady, rejectReady) => {
      let settled = false;
      const readyTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          rejectReady(new Error('Timed out waiting for wisper-win-helper.exe ready event'));
        }
      }, 6000);

      const child = spawn(exePath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      this.proc = child;
      this.helperPid = child.pid ?? null;

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        this.stdoutBuffer += chunk;
        let nlIdx: number;
        while ((nlIdx = this.stdoutBuffer.indexOf('\n')) !== -1) {
          const line = this.stdoutBuffer.slice(0, nlIdx).replace(/\r$/, '').trim();
          this.stdoutBuffer = this.stdoutBuffer.slice(nlIdx + 1);
          if (!line) continue;

          let msg: HelperMessage;
          try {
            msg = JSON.parse(line) as HelperMessage;
          } catch {
            continue;
          }

          if (msg.event === 'ready') {
            if (typeof msg.pid === 'number') {
              this.helperPid = msg.pid;
            }
            if (!settled) {
              settled = true;
              clearTimeout(readyTimer);
              resolveReady();
            }
            continue;
          }

          this.handleMessage(msg);
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        const text = chunk.trim();
        if (text) {
          console.warn('[WindowsBridge] stderr:', text);
        }
      });

      child.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(readyTimer);
          rejectReady(err);
        }
      });

      child.on('exit', (code, signal) => {
        const wasCurrent = this.proc === child;
        if (wasCurrent) {
          this.proc = null;
          this.helperPid = null;
        }
        this.rejectAllPending(
          new Error(`wisper-win-helper.exe exited (code=${code}, signal=${signal})`)
        );

        if (!settled) {
          settled = true;
          clearTimeout(readyTimer);
          rejectReady(new Error(`wisper-win-helper.exe exited before ready (code=${code})`));
          return;
        }

        if (wasCurrent && !this.stopping && !this.restartedOnce) {
          this.restartedOnce = true;
          console.warn('[WindowsBridge] helper crashed unexpectedly; restarting once...');
          void this.restartOnce();
        }
      });
    });
  }

  private async restartOnce(): Promise<void> {
    try {
      await this.spawnHelper();
      if (this.currentShortcuts) {
        await this.updateShortcuts(this.currentShortcuts);
      }
    } catch (err) {
      console.error('[WindowsBridge] failed to restart helper:', err);
    }
  }

  private handleMessage(msg: HelperMessage): void {
    if (msg.event === 'reply' && typeof msg.id === 'number') {
      const entry = this.pending.get(msg.id);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(msg.id);
        entry.resolve(msg);
      }
      return;
    }

    const handlers = this.handlers;
    if (!handlers) return;

    switch (msg.event) {
      case 'ptt-down':
        handlers.onPttDown();
        break;
      case 'ptt-up':
        handlers.onPttUp();
        break;
      case 'ptt-other-key':
        handlers.onPttOtherKey(msg.vk ?? '');
        break;
      case 'hands-free-pressed':
        handlers.onHandsFreePressed();
        break;
      case 'cancel-pressed':
        handlers.onCancelPressed();
        break;
      case 'paste-last-pressed':
        handlers.onPasteLastPressed();
        break;
      case 'copy-last-pressed':
        handlers.onCopyLastPressed();
        break;
      case 'captured':
        if (typeof msg.shortcut === 'string') {
          handlers.onShortcutCaptured(msg.shortcut);
        }
        break;
      case 'error':
        console.warn('[WindowsBridge] helper reported error:', msg.message ?? 'unknown');
        break;
      default:
        break;
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(err);
    }
  }

  private sendCommand(
    cmd: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 5000
  ): Promise<HelperMessage> {
    const child = this.proc;
    if (!child || !child.stdin.writable) {
      return Promise.reject(new Error(`Cannot send "${cmd}": wisper-win-helper is not running`));
    }

    const id = this.nextId++;
    const line = JSON.stringify({ id, cmd, ...payload }) + '\n';

    return new Promise<HelperMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Windows helper command "${cmd}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      child.stdin.write(line, 'utf8', (writeErr) => {
        if (writeErr) {
          const entry = this.pending.get(id);
          if (entry) {
            clearTimeout(entry.timer);
            this.pending.delete(id);
            reject(writeErr);
          }
        }
      });
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.proc;
    if (!child) {
      this.rejectAllPending(new Error('WindowsBridge stopped'));
      return;
    }

    try {
      await this.sendCommand('quit', {}, 1200);
    } catch {
      // Proceed to force cleanup if quit times out
    }

    try {
      child.stdin.end();
    } catch {
      // Ignore stdin close errors
    }

    if (this.proc === child && !child.killed) {
      try {
        child.kill();
      } catch {
        // Ignore kill errors
      }
    }

    this.proc = null;
    this.helperPid = null;
    this.rejectAllPending(new Error('WindowsBridge stopped'));
  }

  async updateShortcuts(shortcuts: ShortcutsConfig): Promise<void> {
    this.currentShortcuts = { ...shortcuts };
    if (!this.proc) return;
    await this.sendCommand('set-shortcuts', {
      pushToTalk: shortcuts.pushToTalk,
      handsFree: shortcuts.handsFree,
      cancel: shortcuts.cancel,
      pasteLast: shortcuts.pasteLast,
      copyLast: shortcuts.copyLast,
    });
  }

  async startShortcutCapture(): Promise<void> {
    await this.sendCommand('start-capture');
  }

  async stopShortcutCapture(): Promise<void> {
    if (!this.proc) return;
    await this.sendCommand('stop-capture');
  }

  async getForegroundApp(): Promise<ForegroundAppInfo> {
    try {
      const res = await this.sendCommand('get-foreground', {}, 3000);
      return {
        processName: typeof res.processName === 'string' ? res.processName : '',
        title: typeof res.title === 'string' ? res.title : '',
        isTerminal: Boolean(res.isTerminal),
      };
    } catch {
      return { processName: '', title: '', isTerminal: false };
    }
  }

  async pasteText(options: PlatformPasteOptions): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await this.sendCommand(
        'paste-text',
        {
          text: options.text,
          restoreClipboard: options.restoreClipboard,
          isTerminal: options.isTerminal,
          terminalMode: options.terminalMode,
        },
        6000
      );
      return {
        ok: Boolean(res.ok),
        error: typeof res.error === 'string' ? res.error : undefined,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async copyText(text: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await this.sendCommand('copy-text', { text }, 4000);
      return {
        ok: Boolean(res.ok),
        error: typeof res.error === 'string' ? res.error : undefined,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async muteOtherAudio(excludePids: number[]): Promise<void> {
    if (!this.proc) return;
    const pidSet = new Set<number>([process.pid]);
    for (const pid of excludePids) {
      if (Number.isInteger(pid) && pid > 0) {
        pidSet.add(pid);
      }
    }
    try {
      await this.sendCommand('mute-others', { excludePids: Array.from(pidSet) }, 4000);
    } catch (err) {
      console.warn('[WindowsBridge] muteOtherAudio failed:', err);
    }
  }

  async unmuteOtherAudio(): Promise<void> {
    if (!this.proc) return;
    try {
      await this.sendCommand('unmute-others', {}, 4000);
    } catch (err) {
      console.warn('[WindowsBridge] unmuteOtherAudio failed:', err);
    }
  }

  async pauseMedia(excludePids: number[]): Promise<void> {
    if (!this.proc) return;
    const pidSet = new Set<number>([process.pid]);
    for (const pid of excludePids) {
      if (Number.isInteger(pid) && pid > 0) pidSet.add(pid);
    }
    try {
      await this.sendCommand('pause-media', { excludePids: Array.from(pidSet) }, 3000);
    } catch {
      // Ignore
    }
  }

  async resumeMedia(): Promise<void> {
    if (!this.proc) return;
    try {
      await this.sendCommand('resume-media', {}, 3000);
    } catch {
      // Ignore
    }
  }

  async focusNativeWindow(hwnd: number | bigint): Promise<void> {
    if (!this.proc) return;
    try {
      await this.sendCommand('focus-window', { hwnd: Number(hwnd) }, 2000);
    } catch {
      // Ignore
    }
  }

  async getOmarchyEnvironment(): Promise<OmarchyEnvironment> {
    const snippets = generateOmarchySnippets();
    return {
      platform: 'win32',
      isLinux: false,
      isWayland: false,
      isHyprland: false,
      isOmarchy: false,
      omarchyVersion: 'none',
      hyprDir: '',
      bindingsFile: '',
      windowRulesFile: '',
      autostartFile: '',
      themeHookInstalled: false,
      bindingsInstalled: false,
      windowRulesInstalled: false,
      palette: null,
      availableTools: {
        hyprctl: false,
        wlCopy: false,
        wtype: false,
        ydotool: false,
        xdotool: false,
        xclip: false,
        pactl: false,
        pwRecord: false,
      },
      generatedLuaSnippet: snippets.luaSnippet,
      generatedConfSnippet: snippets.confSnippet,
    };
  }

  getHelperPids(): number[] {
    return this.helperPid ? [this.helperPid] : [];
  }
}
