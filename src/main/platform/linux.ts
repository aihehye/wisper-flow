import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { globalShortcut } from 'electron';
import { TERMINAL_PROCESS_NAMES } from '../../shared/defaults';
import type { LinuxPasteBackend, OmarchyEnvironment, ShortcutsConfig } from '../../shared/types';
import {
  applyOmarchySetup,
  detectOmarchyEnvironment,
  readOmarchyPalette,
  removeOmarchySetup,
  watchOmarchyTheme,
} from './omarchy';
import type {
  ForegroundAppInfo,
  PlatformBridge,
  PlatformEventHandlers,
  PlatformPasteOptions,
} from './types';

const execFileAsync = promisify(execFile);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFileAsync('which', [cmd], { timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

function isWaylandSession(): boolean {
  return Boolean(process.env.WAYLAND_DISPLAY) || process.env.XDG_SESSION_TYPE === 'wayland';
}

function isHyprlandSession(): boolean {
  return Boolean(process.env.HYPRLAND_INSTANCE_SIGNATURE);
}

function toElectronAccelerator(raw: string): string | null {
  const parts = raw
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;

  const mapped: string[] = [];
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'rightalt' || lower === 'leftalt' || lower === 'rightctrl' || lower === 'leftctrl') {
      // Electron globalShortcut does not support side-specific modifier-only keys
      return null;
    }
    if (lower === 'ctrl' || lower === 'control') mapped.push('CommandOrControl');
    else if (lower === 'win' || lower === 'super' || lower === 'meta') mapped.push('Super');
    else if (lower === 'alt') mapped.push('Alt');
    else if (lower === 'shift') mapped.push('Shift');
    else if (lower === 'esc' || lower === 'escape') mapped.push('Escape');
    else if (lower === 'space') mapped.push('Space');
    else mapped.push(part.length === 1 ? part.toUpperCase() : part);
  }

  return mapped.join('+');
}

function spawnWriteStdin(
  command: string,
  args: string[],
  input: string,
  timeoutMs = 2500
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          child.kill();
        } catch {
          // Ignore kill errors
        }
        resolve({ ok: false, error: `${command} timed out` });
      }
    }, timeoutMs);

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, error: err.message });
      }
    });

    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          resolve({ ok: true });
        } else {
          resolve({ ok: false, error: stderr.trim() || `${command} exited with code ${code}` });
        }
      }
    });

    child.stdin.on('error', () => {
      // Handled via exit/error events
    });
    child.stdin.end(input, 'utf8');
  });
}

export class LinuxBridge implements PlatformBridge {
  readonly kind = 'linux' as const;

  private handlers: PlatformEventHandlers | null = null;
  private shortcuts: ShortcutsConfig | null = null;
  private server: net.Server | null = null;
  private socketPath = path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), 'wisper-flow.sock');
  private unwatchTheme: (() => void) | null = null;
  private mutedSinkInputIds = new Set<string>();
  private pausedLinuxMedia = false;
  private restoreTimer: ReturnType<typeof setTimeout> | null = null;
  private registeredShortcuts = false;

  async start(handlers: PlatformEventHandlers, shortcuts: ShortcutsConfig): Promise<void> {
    this.handlers = handlers;
    this.shortcuts = { ...shortcuts };

    await this.startSocketServer();
    this.unwatchTheme = watchOmarchyTheme((palette) => {
      this.handlers?.onPaletteChanged?.(palette);
    });
    this.syncGlobalShortcuts(shortcuts);
  }

  private async startSocketServer(): Promise<void> {
    try {
      if (fs.existsSync(this.socketPath)) {
        fs.unlinkSync(this.socketPath);
      }
    } catch {
      // Ignore unlink errors
    }

    const server = net.createServer((conn) => {
      let buffer = '';
      conn.setEncoding('utf8');

      const flushLines = (finalFlush: boolean) => {
        let nlIdx: number;
        while ((nlIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nlIdx).trim();
          buffer = buffer.slice(nlIdx + 1);
          if (line) {
            void this.handleSocketCommand(line, conn);
          }
        }
        if (finalFlush) {
          const rem = buffer.trim();
          buffer = '';
          if (rem) {
            void this.handleSocketCommand(rem, conn);
          }
        }
      };

      conn.on('data', (chunk: string) => {
        buffer += chunk;
        flushLines(false);
      });

      conn.on('end', () => {
        flushLines(true);
      });

      conn.on('error', () => {
        // Ignore transient client disconnects
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        server.removeListener('error', reject);
        try {
          fs.chmodSync(this.socketPath, 0o600);
        } catch {
          // Ignore chmod errors
        }
        resolve();
      });
    });

    this.server = server;
  }

  private async handleSocketCommand(cmdLine: string, conn: net.Socket): Promise<void> {
    const cmd = cmdLine.trim().toLowerCase();
    const handlers = this.handlers;
    let reply = 'ok\n';

    switch (cmd) {
      case 'ptt-start':
        handlers?.onDirectPttStart?.();
        break;
      case 'ptt-stop':
        handlers?.onDirectPttStop?.();
        break;
      case 'toggle':
        handlers?.onDirectToggle?.();
        break;
      case 'cancel':
        handlers?.onCancelPressed();
        break;
      case 'paste-last':
        handlers?.onPasteLastPressed();
        break;
      case 'copy-last':
        handlers?.onCopyLastPressed();
        break;
      case 'show-hub':
        handlers?.onShowHub?.();
        break;
      case 'toggle-hud':
        handlers?.onToggleHud?.();
        break;
      case 'reload-theme': {
        const palette = readOmarchyPalette();
        handlers?.onPaletteChanged?.(palette);
        handlers?.onReloadTheme?.();
        break;
      }
      case 'status':
        reply =
          JSON.stringify({
            ok: true,
            pid: process.pid,
            socket: this.socketPath,
            isWayland: isWaylandSession(),
            isHyprland: isHyprlandSession(),
          }) + '\n';
        break;
      default:
        reply = `error: unknown command "${cmd}"\n`;
        break;
    }

    try {
      if (!conn.destroyed) {
        conn.end(reply);
      }
    } catch {
      // Ignore write errors on closed socket
    }
  }

  private syncGlobalShortcuts(shortcuts: ShortcutsConfig): void {
    this.unregisterGlobalShortcuts();

    // On Hyprland/Omarchy, compositor bindings in hyprland/bindings files handle shortcuts natively.
    if (isHyprlandSession()) {
      return;
    }

    const candidates: Array<{ raw: string; handler: () => void; skipBareEscape?: boolean }> = [
      {
        raw: shortcuts.handsFree,
        handler: () => this.handlers?.onHandsFreePressed(),
      },
      {
        raw: shortcuts.pasteLast,
        handler: () => this.handlers?.onPasteLastPressed(),
      },
      {
        raw: shortcuts.copyLast,
        handler: () => this.handlers?.onCopyLastPressed(),
      },
      {
        raw: shortcuts.cancel,
        handler: () => this.handlers?.onCancelPressed(),
        // Do not hijack bare Esc globally on X11/GNOME outside active dictation
        skipBareEscape: true,
      },
    ];

    for (const item of candidates) {
      const accel = toElectronAccelerator(item.raw);
      if (!accel) continue;
      if (item.skipBareEscape && accel === 'Escape') continue;
      try {
        globalShortcut.register(accel, item.handler);
        this.registeredShortcuts = true;
      } catch {
        // Wayland or desktop environment may reject globalShortcut.register; never fail startup
      }
    }
  }

  private unregisterGlobalShortcuts(): void {
    if (!this.registeredShortcuts) return;
    this.registeredShortcuts = false;
    try {
      globalShortcut.unregisterAll();
    } catch {
      // Ignore Electron shortcut cleanup errors
    }
  }

  async stop(): Promise<void> {
    if (this.restoreTimer) {
      clearTimeout(this.restoreTimer);
      this.restoreTimer = null;
    }

    await this.unmuteOtherAudio();
    this.unregisterGlobalShortcuts();

    if (this.unwatchTheme) {
      this.unwatchTheme();
      this.unwatchTheme = null;
    }

    if (this.server) {
      const srv = this.server;
      this.server = null;
      await new Promise<void>((resolve) => {
        srv.close(() => resolve());
      });
    }

    try {
      if (fs.existsSync(this.socketPath)) {
        fs.unlinkSync(this.socketPath);
      }
    } catch {
      // Ignore unlink errors
    }
  }

  async updateShortcuts(shortcuts: ShortcutsConfig): Promise<void> {
    this.shortcuts = { ...shortcuts };
    this.syncGlobalShortcuts(shortcuts);
  }

  async startShortcutCapture(): Promise<void> {
    // Shortcuts on Linux are edited directly or via Hyprland/Omarchy configs
  }

  async stopShortcutCapture(): Promise<void> {
    // No-op on Linux
  }

  async getForegroundApp(): Promise<ForegroundAppInfo> {
    if (isHyprlandSession()) {
      try {
        const { stdout } = await execFileAsync('hyprctl', ['activewindow', '-j'], {
          timeout: 1500,
        });
        const data = JSON.parse(stdout) as {
          class?: string;
          initialClass?: string;
          title?: string;
        };
        const procName = String(data.class || data.initialClass || '').trim();
        const title = String(data.title || '').trim();
        return {
          processName: procName,
          title,
          isTerminal: TERMINAL_PROCESS_NAMES.has(procName.toLowerCase()),
        };
      } catch {
        return { processName: '', title: '', isTerminal: false };
      }
    }

    try {
      const { stdout: winIdRaw } = await execFileAsync('xdotool', ['getactivewindow'], {
        timeout: 1200,
      });
      const winId = winIdRaw.trim();
      if (!winId) return { processName: '', title: '', isTerminal: false };

      const [clsRes, titleRes] = await Promise.allSettled([
        execFileAsync('xdotool', ['getwindowclassname', winId], { timeout: 1200 }),
        execFileAsync('xdotool', ['getwindowname', winId], { timeout: 1200 }),
      ]);

      const procName = clsRes.status === 'fulfilled' ? clsRes.value.stdout.trim() : '';
      const title = titleRes.status === 'fulfilled' ? titleRes.value.stdout.trim() : '';
      return {
        processName: procName,
        title,
        isTerminal: TERMINAL_PROCESS_NAMES.has(procName.toLowerCase()),
      };
    } catch {
      return { processName: '', title: '', isTerminal: false };
    }
  }

  async copyText(text: string): Promise<{ ok: boolean; error?: string }> {
    if (isWaylandSession() || (await commandExists('wl-copy'))) {
      const res = await spawnWriteStdin('wl-copy', ['--type', 'text/plain;charset=utf-8'], text);
      if (res.ok) return res;
      if (isWaylandSession()) return res;
    }

    if (await commandExists('xclip')) {
      return spawnWriteStdin('xclip', ['-selection', 'clipboard'], text);
    }

    if (await commandExists('xsel')) {
      return spawnWriteStdin('xsel', ['--clipboard', '--input'], text);
    }

    return { ok: false, error: 'No clipboard tool found (install wl-clipboard or xclip)' };
  }

  private async snapshotTextClipboard(): Promise<string | null> {
    if (isWaylandSession()) {
      try {
        const { stdout: typesRaw } = await execFileAsync('wl-paste', ['--list-types'], {
          timeout: 500,
        });
        const types = typesRaw
          .split(/\r?\n/)
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean);
        const hasText = types.some(
          (t) => t.startsWith('text/plain') || t === 'utf8_string' || t === 'string'
        );
        const hasBinaryImage = types.some((t) => t.startsWith('image/'));
        if (!hasText || hasBinaryImage) return null;

        const { stdout } = await execFileAsync('wl-paste', ['--no-newline'], { timeout: 500 });
        return stdout;
      } catch {
        return null;
      }
    }

    try {
      const { stdout: targetsRaw } = await execFileAsync(
        'xclip',
        ['-o', '-selection', 'clipboard', '-t', 'TARGETS'],
        { timeout: 500 }
      );
      const targets = targetsRaw
        .split(/\r?\n/)
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
      const hasText = targets.some(
        (t) => t.startsWith('text/plain') || t === 'utf8_string' || t === 'string'
      );
      const hasImage = targets.some((t) => t.startsWith('image/'));
      if (!hasText || hasImage) return null;

      const { stdout } = await execFileAsync('xclip', ['-o', '-selection', 'clipboard'], {
        timeout: 500,
      });
      return stdout;
    } catch {
      return null;
    }
  }

  private async resolvePasteBackend(
    requested: LinuxPasteBackend
  ): Promise<Exclude<LinuxPasteBackend, 'auto'> | null> {
    if (requested !== 'auto') {
      return requested;
    }

    if (isHyprlandSession() && (await commandExists('hyprctl'))) {
      return 'hyprctl';
    }
    if (isWaylandSession() && (await commandExists('wtype'))) {
      return 'wtype';
    }
    if (await commandExists('ydotool')) {
      return 'ydotool';
    }
    if (!isWaylandSession() && (await commandExists('xdotool'))) {
      return 'xdotool';
    }
    if (await commandExists('wtype')) {
      return 'wtype';
    }
    if (await commandExists('xdotool')) {
      return 'xdotool';
    }
    return null;
  }

  private async triggerPasteShortcut(
    backend: Exclude<LinuxPasteBackend, 'auto'>,
    options: PlatformPasteOptions
  ): Promise<boolean> {
    const useShiftInsert = options.isTerminal && options.terminalMode === 'shift-insert';
    const useCtrlShiftV = options.isTerminal && !useShiftInsert;

    try {
      switch (backend) {
        case 'hyprctl': {
          const spec = useShiftInsert
            ? 'SHIFT, Insert, activewindow'
            : useCtrlShiftV
              ? 'CTRL SHIFT, v, activewindow'
              : 'CTRL, v, activewindow';
          await execFileAsync('hyprctl', ['dispatch', 'sendshortcut', spec], { timeout: 1500 });
          return true;
        }
        case 'wtype': {
          const args = useShiftInsert
            ? ['-M', 'shift', '-k', 'Insert', '-m', 'shift']
            : useCtrlShiftV
              ? ['-M', 'ctrl', '-M', 'shift', '-k', 'v', '-m', 'shift', '-m', 'ctrl']
              : ['-M', 'ctrl', '-k', 'v', '-m', 'ctrl'];
          await execFileAsync('wtype', args, { timeout: 1500 });
          return true;
        }
        case 'ydotool': {
          // Linux input event keycodes: 29=KEY_LEFTCTRL, 42=KEY_LEFTSHIFT, 47=KEY_V, 110=KEY_INSERT
          const args = useShiftInsert
            ? ['key', '42:1', '110:1', '110:0', '42:0']
            : useCtrlShiftV
              ? ['key', '29:1', '42:1', '47:1', '47:0', '42:0', '29:0']
              : ['key', '29:1', '47:1', '47:0', '29:0'];
          await execFileAsync('ydotool', args, { timeout: 1500 });
          return true;
        }
        case 'xdotool': {
          const combo = useShiftInsert
            ? 'shift+Insert'
            : useCtrlShiftV
              ? 'ctrl+shift+v'
              : 'ctrl+v';
          await execFileAsync('xdotool', ['key', '--clearmodifiers', combo], { timeout: 1500 });
          return true;
        }
      }
    } catch {
      return false;
    }
  }

  async pasteText(options: PlatformPasteOptions): Promise<{ ok: boolean; error?: string }> {
    if (this.restoreTimer) {
      clearTimeout(this.restoreTimer);
      this.restoreTimer = null;
    }

    const savedClipboard = options.restoreClipboard ? await this.snapshotTextClipboard() : null;

    const copied = await this.copyText(options.text);
    if (!copied.ok) {
      return copied;
    }

    await delay(35);

    const backend = await this.resolvePasteBackend(options.linuxPasteBackend ?? 'auto');
    const pasted = backend ? await this.triggerPasteShortcut(backend, options) : false;

    if (!pasted) {
      return { ok: false, error: 'Copied to clipboard — press Ctrl+V to paste' };
    }

    if (options.restoreClipboard && savedClipboard !== null) {
      this.restoreTimer = setTimeout(() => {
        this.restoreTimer = null;
        void this.copyText(savedClipboard);
      }, 220);
    }

    return { ok: true };
  }

  async muteOtherAudio(excludePids: number[]): Promise<void> {
    if (!(await commandExists('pactl'))) return;

    const exclude = new Set<number>([process.pid]);
    for (const pid of excludePids) {
      if (Number.isInteger(pid) && pid > 0) {
        exclude.add(pid);
      }
    }

    try {
      const { stdout } = await execFileAsync('pactl', ['list', 'sink-inputs'], { timeout: 2000 });
      const blocks = stdout.split(/(?=Sink Input #\d+)/g);

      for (const block of blocks) {
        const idMatch = block.match(/^Sink Input #(\d+)/);
        if (!idMatch) continue;
        const sinkInputId = idMatch[1];

        const muteMatch = block.match(/^\s*Mute:\s*(\S+)/im);
        if (!muteMatch || muteMatch[1].toLowerCase() !== 'no') {
          continue;
        }

        const pidMatch = block.match(/application\.process\.id\s*=\s*"(\d+)"/i);
        const appPid = pidMatch ? Number.parseInt(pidMatch[1], 10) : NaN;
        if (Number.isInteger(appPid) && exclude.has(appPid)) {
          continue;
        }

        try {
          await execFileAsync('pactl', ['set-sink-input-mute', sinkInputId, '1'], {
            timeout: 1500,
          });
          this.mutedSinkInputIds.add(sinkInputId);
        } catch {
          // Ignore sink inputs that vanish mid-loop
        }
      }
    } catch {
      // Ignore pactl failures when PipeWire/PulseAudio isn't running
    }
  }

  async unmuteOtherAudio(): Promise<void> {
    if (this.mutedSinkInputIds.size === 0) return;

    const ids = Array.from(this.mutedSinkInputIds);
    this.mutedSinkInputIds.clear();

    await Promise.all(
      ids.map(async (sinkInputId) => {
        try {
          await execFileAsync('pactl', ['set-sink-input-mute', sinkInputId, '0'], {
            timeout: 1500,
          });
        } catch {
          // Ignore already-closed sink inputs
        }
      })
    );
  }

  async pauseMedia(): Promise<void> {
    if (this.pausedLinuxMedia || !(await commandExists('playerctl'))) return;
    try {
      const { stdout } = await execFileAsync('playerctl', ['status'], { timeout: 1200 });
      if (stdout.trim().toLowerCase() === 'playing') {
        await execFileAsync('playerctl', ['pause'], { timeout: 1200 });
        this.pausedLinuxMedia = true;
      }
    } catch {
      // No active MPRIS media player
    }
  }

  async resumeMedia(): Promise<void> {
    if (!this.pausedLinuxMedia) return;
    this.pausedLinuxMedia = false;
    try {
      await execFileAsync('playerctl', ['play'], { timeout: 1200 });
    } catch {
      // Ignore
    }
  }

  async getOmarchyEnvironment(): Promise<OmarchyEnvironment> {
    return detectOmarchyEnvironment();
  }

  async applyOmarchySetup(): Promise<OmarchyEnvironment> {
    return applyOmarchySetup(undefined, this.shortcuts ?? undefined);
  }

  async removeOmarchySetup(): Promise<OmarchyEnvironment> {
    return removeOmarchySetup();
  }

  getHelperPids(): number[] {
    return [];
  }
}
