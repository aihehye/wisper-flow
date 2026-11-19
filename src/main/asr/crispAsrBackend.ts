import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { GpuDeviceInfo, ModelStatus, RumbleOptions } from '../../shared/types';
import type { AsrBackend, TranscribeRequest, TranscribeResult } from './types';
import { getModelPaths } from './modelManager';
import {
  cleanRumbleOutput,
  findFreePort,
  killProcessTree,
  parseDeviceListOutput,
} from './llamaServerBackend';
import { splitWavIntoChunks, trimSilenceWav } from './wavUtils';

const execFileAsync = promisify(execFile);

export function buildCrispAsrPrefix(rumble: RumbleOptions): string {
  const tags: string[] = [];
  if (rumble.digits) tags.push('<digits>');
  if (!rumble.filler) tags.push('<nofiller>');
  if (rumble.verbatim) tags.push('<verbatim>');
  return tags.join('');
}

export class CrispAsrBackend implements AsrBackend {
  readonly id = 'crispasr' as const;

  private readonly resourcesDir?: string;
  private readonly listeners = new Set<(status: ModelStatus) => void>();
  private proc: ChildProcess | null = null;
  private baseUrl: string | null = null;
  private isStopping = false;
  private startPromise: Promise<void> | null = null;
  private currentPrefix = '<digits><nofiller><verbatim>';
  private lastStartOptions: { gpuDeviceId: string; customBinaryPath?: string } | null = null;
  private status: ModelStatus;

  constructor(options?: { resourcesDir?: string }) {
    this.resourcesDir = options?.resourcesDir;
    const paths = getModelPaths(this.resourcesDir);
    this.status = {
      state: 'uninitialized',
      engine: 'crispasr',
      modelName: 'crispasr (Rumble-2-Flash)',
      modelPresent: paths.modelPresent,
      mmprojPresent: paths.mmprojPresent,
      runtimePresent: false,
      activeDeviceId: 'auto',
      activeDeviceName: 'Default Device',
      availableDevices: [],
    };
  }

  onStatusChange(cb: (status: ModelStatus) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  getStatus(): ModelStatus {
    return { ...this.status, availableDevices: [...this.status.availableDevices] };
  }

  private updateStatus(patch: Partial<ModelStatus>): void {
    this.status = { ...this.status, ...patch };
    const snapshot = this.getStatus();
    for (const cb of this.listeners) {
      try {
        cb(snapshot);
      } catch {
        // Ignore listener errors
      }
    }
  }

  private async resolveBinaryPath(customBinaryPath?: string): Promise<string | null> {
    if (customBinaryPath && customBinaryPath.trim()) {
      const explicit = customBinaryPath.trim();
      if (fs.existsSync(explicit)) {
        return explicit;
      }
    }

    const binName = process.platform === 'win32' ? 'crispasr.exe' : 'crispasr';
    if (this.resourcesDir) {
      const localBin = path.join(this.resourcesDir, 'runtime', 'crispasr', binName);
      if (fs.existsSync(localBin)) {
        return localBin;
      }
    }

    const locator = process.platform === 'win32' ? 'where' : 'which';
    try {
      const { stdout } = await execFileAsync(locator, [binName], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
      });
      const firstLine = stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
      if (firstLine && fs.existsSync(firstLine.trim())) {
        return firstLine.trim();
      }
    } catch {
      // Not on PATH
    }

    return null;
  }

  async listDevices(customBinaryPath?: string): Promise<GpuDeviceInfo[]> {
    const binPath = await this.resolveBinaryPath(customBinaryPath);
    if (!binPath) {
      this.updateStatus({ availableDevices: [] });
      return [];
    }

    try {
      const { stdout, stderr } = await execFileAsync(binPath, ['--list-devices'], {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
      });
      const devices = parseDeviceListOutput(`${stdout ?? ''}\n${stderr ?? ''}`);
      this.updateStatus({ availableDevices: devices });
      return devices;
    } catch {
      return this.status.availableDevices;
    }
  }

  async start(options: { gpuDeviceId: string; customBinaryPath?: string }): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.startInternal(options);
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async startInternal(options: {
    gpuDeviceId: string;
    customBinaryPath?: string;
  }): Promise<void> {
    if (this.proc && this.proc.exitCode === null && this.baseUrl) {
      await this.stop();
    }

    this.lastStartOptions = { ...options };
    const binPath = await this.resolveBinaryPath(options.customBinaryPath);
    const paths = getModelPaths(this.resourcesDir);

    if (!binPath) {
      this.updateStatus({
        state: 'missing',
        runtimePresent: false,
        modelPresent: paths.modelPresent,
        mmprojPresent: paths.mmprojPresent,
        errorMessage: 'crispasr binary not found. Set custom crispASR path in Settings.',
      });
      throw new Error('crispasr binary not found. Configure a custom crispASR path in Settings.');
    }

    this.updateStatus({
      state: 'starting',
      runtimePresent: true,
      modelPresent: paths.modelPresent,
      mmprojPresent: paths.mmprojPresent,
      activeDeviceId: options.gpuDeviceId || 'auto',
      activeDeviceName: options.gpuDeviceId === 'auto' ? 'Auto (crispASR)' : options.gpuDeviceId,
      errorMessage: undefined,
    });

    const port = await findFreePort('127.0.0.1');
    const baseUrl = `http://127.0.0.1:${port}`;
    const args = ['--server', '--host', '127.0.0.1', '--port', String(port)];
    if (paths.modelPresent) {
      args.push('-m', paths.modelPath);
    }

    this.isStopping = false;
    let stderrTail = '';
    const proc = spawn(binPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        CRISPASR_QWEN3_SYSTEM_PREFIX: this.currentPrefix,
      },
    });

    proc.stderr?.on('data', (chunk: Buffer | string) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });
    proc.stdout?.on('data', (chunk: Buffer | string) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });

    this.proc = proc;
    this.baseUrl = baseUrl;

    let earlyExitError: Error | null = null;
    proc.once('exit', (code, signal) => {
      if (this.proc === proc) {
        this.proc = null;
        this.baseUrl = null;
      }
      if (!this.isStopping) {
        const msg = `crispasr exited unexpectedly (code=${code}, signal=${signal})${stderrTail ? `: ${stderrTail.slice(-300)}` : ''}`;
        earlyExitError = new Error(msg);
        if (this.status.state === 'ready' || this.status.state === 'starting') {
          this.updateStatus({ state: 'error', errorMessage: msg });
        }
      }
    });

    try {
      await this.waitForHealth(baseUrl, () => earlyExitError);
      this.updateStatus({ state: 'ready', errorMessage: undefined });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.updateStatus({ state: 'error', errorMessage: message });
      await this.stop();
      throw err;
    }
  }

  private async waitForHealth(
    baseUrl: string,
    getExitError: () => Error | null,
    timeoutMs = 45000
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const exitErr = getExitError();
      if (exitErr) throw exitErr;

      try {
        const res = await fetch(`${baseUrl}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) {
          try {
            const data = (await res.json()) as { status?: string; ok?: boolean };
            if (
              data?.status === 'ok' ||
              data?.status === 'ready' ||
              data?.ok === true ||
              data?.status === undefined
            ) {
              return;
            }
          } catch {
            return;
          }
        }
      } catch {
        // Still booting
      }

      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('Timed out waiting for crispasr /health check');
  }

  async stop(): Promise<void> {
    this.isStopping = true;
    const proc = this.proc;
    this.proc = null;
    this.baseUrl = null;

    if (proc) {
      await killProcessTree(proc);
    }

    if (this.status.state !== 'error') {
      this.updateStatus({ state: 'uninitialized' });
    }
  }

  async restart(options: { gpuDeviceId: string; customBinaryPath?: string }): Promise<void> {
    await this.stop();
    await this.start(options);
  }

  async transcribe(req: TranscribeRequest): Promise<TranscribeResult> {
    const desiredPrefix = buildCrispAsrPrefix(req.rumble);
    if (desiredPrefix !== this.currentPrefix && this.lastStartOptions) {
      this.currentPrefix = desiredPrefix;
      await this.restart(this.lastStartOptions);
    }

    if (this.status.state !== 'ready' || !this.baseUrl) {
      throw new Error(`CrispAsrBackend is not ready (state=${this.status.state})`);
    }

    const t0 = performance.now();
    const trimmed = trimSilenceWav(req.wavBuffer);
    const chunks = splitWavIntoChunks(trimmed, 28, 16);

    const texts: string[] = [];
    let detectedLanguage: string | undefined;

    for (const chunk of chunks) {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(chunk)], { type: 'audio/wav' }), 'audio.wav');
      if (req.language && req.language !== 'auto') {
        form.append('language', req.language);
      }
      form.append('temperature', '0');
      if (req.contextHints && req.contextHints.length > 0) {
        const contextStr = req.contextHints
          .map((h) => h.trim())
          .filter(Boolean)
          .slice(0, 60)
          .join(', ');
        if (contextStr) {
          form.append('context', contextStr);
        }
      }
      form.append('vad', 'true');

      const res = await fetch(`${this.baseUrl}/v1/audio/transcriptions`, {
        method: 'POST',
        body: form,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`crispasr HTTP ${res.status}: ${errBody}`);
      }

      const data = (await res.json()) as { text?: string; language?: string };
      const cleaned = cleanRumbleOutput(data.text ?? '');
      if (!detectedLanguage) {
        detectedLanguage = data.language || cleaned.detectedLanguage;
      }
      if (cleaned.text) {
        texts.push(cleaned.text);
      }
    }

    const asrLatencyMs = Math.round(performance.now() - t0);
    return {
      rawText: texts.join(' ').trim(),
      detectedLanguage,
      asrLatencyMs,
    };
  }
}
