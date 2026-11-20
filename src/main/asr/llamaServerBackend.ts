import fs from 'node:fs';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { GpuDeviceInfo, ModelStatus } from '../../shared/types';
import type { AsrBackend, TranscribeRequest, TranscribeResult } from './types';
import { getLlamaServerBinaryPath, getModelPaths } from './modelManager';
import { encodePcm16MonoWav, splitWavIntoChunks, trimSilenceWav } from './wavUtils';

const execFileAsync = promisify(execFile);

export function parseDeviceListOutput(output: string): GpuDeviceInfo[] {
  const devices: GpuDeviceInfo[] = [];
  const seen = new Set<string>();

  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(Vulkan\d+|CUDA\d+|ROCm\d+|Metal\d+|CPU\d*)\s*:\s*(.+)$/i);
    if (!match) continue;

    const id = match[1].trim();
    const description = match[2].trim();
    if (seen.has(id)) continue;
    seen.add(id);

    const lowerId = id.toLowerCase();
    const lowerDesc = description.toLowerCase();

    let vendor: GpuDeviceInfo['vendor'] = 'other';
    let isDiscrete = false;

    if (lowerId.startsWith('cpu') || lowerDesc === 'cpu') {
      vendor = 'cpu';
      isDiscrete = false;
    } else if (
      lowerDesc.includes('nvidia') ||
      lowerDesc.includes('geforce') ||
      lowerDesc.includes('rtx') ||
      lowerDesc.includes('gtx') ||
      lowerDesc.includes('quadro') ||
      lowerDesc.includes('tesla')
    ) {
      vendor = 'nvidia';
      isDiscrete = true;
    } else if (lowerDesc.includes('intel')) {
      vendor = 'intel';
      isDiscrete = lowerDesc.includes('arc ');
    } else if (lowerDesc.includes('amd') || lowerDesc.includes('radeon')) {
      vendor = 'amd';
      isDiscrete =
        lowerDesc.includes('radeon rx') ||
        lowerDesc.includes('radeon pro') ||
        (lowerDesc.includes('amd') &&
          !lowerDesc.includes('graphics') &&
          !lowerDesc.includes('integrated'));
    }

    devices.push({ id, description, vendor, isDiscrete });
  }

  return devices;
}

export function pickBestGpuDevice(
  devices: GpuDeviceInfo[],
  preferredId: string
): GpuDeviceInfo | null {
  if (devices.length === 0) return null;

  if (preferredId && preferredId !== 'auto') {
    const explicit = devices.find((d) => d.id.toLowerCase() === preferredId.toLowerCase());
    if (explicit) return explicit;
  }

  const discreteNvidia = devices.find(
    (d) =>
      d.vendor === 'nvidia' &&
      (d.isDiscrete || /rtx|gtx|geforce/i.test(d.description))
  );
  if (discreteNvidia) return discreteNvidia;

  const anyNvidia = devices.find((d) => d.vendor === 'nvidia');
  if (anyNvidia) return anyNvidia;

  const discreteAmd = devices.find(
    (d) =>
      d.vendor === 'amd' &&
      (d.isDiscrete || /radeon\s+rx/i.test(d.description))
  );
  if (discreteAmd) return discreteAmd;

  const anyDiscrete = devices.find((d) => d.isDiscrete && d.vendor !== 'cpu');
  if (anyDiscrete) return anyDiscrete;

  const firstNonCpu = devices.find((d) => d.vendor !== 'cpu');
  if (firstNonCpu) return firstNonCpu;

  return devices.find((d) => d.vendor === 'cpu') ?? devices[0] ?? null;
}

export function cleanRumbleOutput(raw: string): { text: string; detectedLanguage?: string } {
  let text = raw.trim();
  let detectedLanguage: string | undefined;

  // Strip special end-of-turn markers if any leaked from llama-server
  text = text.replace(/(?:<\|im_end\|>|<\|endoftext\|>)+$/g, '').trim();

  // Handle auto-detect prefix: "language English<asr_text>..." or "<asr_text>..."
  const prefixMatch = text.match(/^(?:language\s+([A-Za-z][A-Za-z\s-]*?))?<asr_text>/i);
  if (prefixMatch) {
    const lang = prefixMatch[1]?.trim();
    if (lang && lang.toLowerCase() !== 'none') {
      detectedLanguage = lang;
    }
    text = text.slice(prefixMatch[0].length).trim();
  }

  // Strip single outer pair of wrapping quotes if the entire output was quoted
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2 && !text.slice(1, -1).includes('"')) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2 && !text.slice(1, -1).includes("'"))
  ) {
    text = text.slice(1, -1).trim();
  }

  return detectedLanguage ? { text, detectedLanguage } : { text };
}

function normalizeOverlapToken(token: string): string {
  return token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase();
}

/**
 * Joins chunk transcripts while deduplicating overlapping boundary words
 * produced by overlapping audio chunks.
 */
export function joinChunkTranscripts(chunks: string[], maxOverlapWords = 6): string {
  const mergedWords: string[] = [];

  for (const rawChunk of chunks) {
    const words = rawChunk.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;

    if (mergedWords.length === 0) {
      mergedWords.push(...words);
      continue;
    }

    const maxK = Math.min(maxOverlapWords, mergedWords.length, words.length);
    let overlapK = 0;

    for (let k = maxK; k >= 1; k--) {
      let allMatch = true;
      for (let i = 0; i < k; i++) {
        const prevNorm = normalizeOverlapToken(mergedWords[mergedWords.length - k + i]);
        const nextNorm = normalizeOverlapToken(words[i]);
        if (!prevNorm || prevNorm !== nextNorm) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) {
        overlapK = k;
        break;
      }
    }

    mergedWords.push(...words.slice(overlapK));
  }

  return mergedWords.join(' ').trim();
}

export async function findFreePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, host, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close(() => reject(new Error('Failed to allocate ephemeral TCP port')));
        return;
      }
      const { port } = addr;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

export async function killProcessTree(proc: ChildProcess, graceMs = 2500): Promise<void> {
  if (proc.exitCode !== null || proc.killed) {
    return;
  }

  const waitForExit = new Promise<void>((resolve) => {
    if (proc.exitCode !== null) {
      resolve();
      return;
    }
    proc.once('exit', () => resolve());
    proc.once('close', () => resolve());
  });

  try {
    proc.kill('SIGTERM');
  } catch {
    // Process may have already exited
  }

  const exitedGracefully = await Promise.race([
    waitForExit.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs)),
  ]);

  if (!exitedGracefully && proc.pid) {
    if (process.platform === 'win32') {
      try {
        await execFileAsync('taskkill', ['/PID', String(proc.pid), '/T', '/F']);
      } catch {
        // Ignore if already exited
      }
    } else {
      try {
        proc.kill('SIGKILL');
      } catch {
        // Ignore
      }
    }
    await Promise.race([
      waitForExit,
      new Promise<void>((resolve) => setTimeout(resolve, 1500)),
    ]);
  }
}

export class LlamaServerBackend implements AsrBackend {
  readonly id = 'llama-server' as const;

  private readonly resourcesDir?: string;
  private readonly listeners = new Set<(status: ModelStatus) => void>();
  private proc: ChildProcess | null = null;
  private baseUrl: string | null = null;
  private isStopping = false;
  private startPromise: Promise<void> | null = null;
  private status: ModelStatus;

  constructor(options?: { resourcesDir?: string }) {
    this.resourcesDir = options?.resourcesDir;
    const paths = getModelPaths(this.resourcesDir);
    const allPresent = paths.modelPresent && paths.mmprojPresent && paths.runtimePresent;
    this.status = {
      state: allPresent ? 'uninitialized' : 'missing',
      engine: 'llama-server',
      modelName: 'Rumble-2-Flash (Q8_0)',
      modelPresent: paths.modelPresent,
      mmprojPresent: paths.mmprojPresent,
      runtimePresent: paths.runtimePresent,
      activeDeviceId: 'auto',
      activeDeviceName: 'Unselected',
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
    if (this.status.state === 'uninitialized' || this.status.state === 'missing') {
      const paths = getModelPaths(this.resourcesDir);
      const allPresent = paths.modelPresent && paths.mmprojPresent && paths.runtimePresent;
      this.status = {
        ...this.status,
        modelPresent: paths.modelPresent,
        mmprojPresent: paths.mmprojPresent,
        runtimePresent: paths.runtimePresent,
        state: allPresent ? 'uninitialized' : 'missing',
      };
    }
    return { ...this.status, availableDevices: [...this.status.availableDevices] };
  }

  private updateStatus(patch: Partial<ModelStatus>): void {
    this.status = { ...this.status, ...patch };
    const snapshot = this.getStatus();
    for (const cb of this.listeners) {
      try {
        cb(snapshot);
      } catch {
        // Do not let one listener break others
      }
    }
  }

  private resolveBinaryPath(customBinaryPath?: string): string | null {
    if (customBinaryPath && customBinaryPath.trim() && fs.existsSync(customBinaryPath.trim())) {
      return customBinaryPath.trim();
    }
    return getLlamaServerBinaryPath(this.resourcesDir);
  }

  async listDevices(customBinaryPath?: string): Promise<GpuDeviceInfo[]> {
    const binPath = this.resolveBinaryPath(customBinaryPath);
    if (!binPath) {
      this.updateStatus({ availableDevices: [] });
      return [];
    }

    try {
      const { stdout, stderr } = await execFileAsync(binPath, ['--list-devices'], {
        encoding: 'utf8',
        timeout: 10000,
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

    const binPath = this.resolveBinaryPath(options.customBinaryPath);
    const paths = getModelPaths(this.resourcesDir);
    const runtimePresent = binPath !== null;

    if (!binPath || !paths.modelPresent || !paths.mmprojPresent) {
      this.updateStatus({
        state: 'missing',
        runtimePresent,
        modelPresent: paths.modelPresent,
        mmprojPresent: paths.mmprojPresent,
        errorMessage: 'Required llama-server binary or Rumble-2-Flash GGUF files are missing.',
      });
      throw new Error('Missing llama-server binary or Rumble-2-Flash GGUF model files.');
    }

    this.updateStatus({
      state: 'starting',
      runtimePresent: true,
      modelPresent: true,
      mmprojPresent: true,
      errorMessage: undefined,
    });

    const devices = await this.listDevices(options.customBinaryPath);
    const chosen = pickBestGpuDevice(devices, options.gpuDeviceId);
    const activeDeviceId = chosen?.id ?? (options.gpuDeviceId || 'auto');
    const activeDeviceName = chosen?.description ?? 'Default Device';

    this.updateStatus({
      activeDeviceId,
      activeDeviceName,
    });

    const port = await findFreePort('127.0.0.1');
    const baseUrl = `http://127.0.0.1:${port}`;
    const args = [
      '-m',
      paths.modelPath,
      '--mmproj',
      paths.mmprojPath,
      '-ngl',
      '99',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--no-webui',
      '-c',
      '4096',
    ];
    if (chosen && chosen.id !== 'auto') {
      args.push('--device', chosen.id);
    }

    this.isStopping = false;
    let stderrTail = '';
    const proc = spawn(binPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
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
    const onUnexpectedExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.proc === proc) {
        this.proc = null;
        this.baseUrl = null;
      }
      if (!this.isStopping) {
        const msg = `llama-server exited unexpectedly (code=${code}, signal=${signal})${stderrTail ? `: ${stderrTail.slice(-300)}` : ''}`;
        earlyExitError = new Error(msg);
        if (this.status.state === 'ready' || this.status.state === 'starting') {
          this.updateStatus({ state: 'error', errorMessage: msg });
        }
      }
    };
    proc.once('exit', onUnexpectedExit);

    try {
      await this.waitForHealth(baseUrl, () => earlyExitError);
      await this.runWarmup(baseUrl);
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
    timeoutMs = 60000
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
          const data = (await res.json()) as { status?: string };
          if (data?.status === 'ok') return;
        }
      } catch {
        // Still booting
      }

      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('Timed out waiting for llama-server /health check');
  }

  private async runWarmup(baseUrl: string): Promise<void> {
    // 0.6s silent 16kHz WAV triggers Vulkan shader JIT during startup rather than first dictation
    const silentSamples = new Int16Array(Math.floor(16000 * 0.6));
    const silentWav = encodePcm16MonoWav(silentSamples, 16000);
    try {
      await this.sendChunkToServer(baseUrl, silentWav, {
        wavBuffer: silentWav,
        language: 'English',
        rumble: { digits: true, filler: false, verbatim: true },
      });
    } catch {
      // Non-fatal if warmup returns an empty/short-clip warning, as long as server remains healthy
      const healthRes = await fetch(`${baseUrl}/health`);
      if (!healthRes.ok) {
        throw new Error('llama-server failed health check after warmup');
      }
    }
  }

  async stop(): Promise<void> {
    this.isStopping = true;
    const proc = this.proc;
    this.proc = null;
    this.baseUrl = null;

    if (proc) {
      await killProcessTree(proc);
    }

    const paths = getModelPaths(this.resourcesDir);
    const allPresent = paths.modelPresent && paths.mmprojPresent && paths.runtimePresent;
    if (this.status.state !== 'error') {
      this.updateStatus({
        state: allPresent ? 'uninitialized' : 'missing',
        modelPresent: paths.modelPresent,
        mmprojPresent: paths.mmprojPresent,
        runtimePresent: paths.runtimePresent,
      });
    }
  }

  async restart(options: { gpuDeviceId: string; customBinaryPath?: string }): Promise<void> {
    await this.stop();
    await this.start(options);
  }

  async transcribe(req: TranscribeRequest): Promise<TranscribeResult> {
    if (this.status.state !== 'ready' || !this.baseUrl) {
      throw new Error(`LlamaServerBackend is not ready (state=${this.status.state})`);
    }

    const t0 = performance.now();
    const trimmed = trimSilenceWav(req.wavBuffer);
    const chunks = splitWavIntoChunks(trimmed, 28, 16);

    const texts: string[] = [];
    let detectedLanguage: string | undefined;

    for (const chunk of chunks) {
      const { text, detectedLanguage: chunkLang } = await this.sendChunkToServer(
        this.baseUrl,
        chunk,
        req
      );
      if (!detectedLanguage && chunkLang) {
        detectedLanguage = chunkLang;
      }
      if (text) {
        texts.push(text);
      }
    }

    const asrLatencyMs = Math.round(performance.now() - t0);
    return {
      rawText: joinChunkTranscripts(texts),
      detectedLanguage,
      asrLatencyMs,
    };
  }

  private async sendChunkToServer(
    baseUrl: string,
    chunkWav: Buffer,
    req: TranscribeRequest
  ): Promise<{ text: string; detectedLanguage?: string }> {
    const messages: Array<Record<string, unknown>> = [];

    if (req.contextHints && req.contextHints.length > 0) {
      const hints = req.contextHints
        .map((h) => h.trim())
        .filter(Boolean)
        .slice(0, 60);
      if (hints.length > 0) {
        messages.push({
          role: 'system',
          content: `Vocabulary: ${hints.join(', ')}`,
        });
      }
    }

    messages.push({
      role: 'user',
      content: [
        {
          type: 'input_audio',
          input_audio: {
            data: chunkWav.toString('base64'),
            format: 'wav',
          },
        },
      ],
    });

    const chatTemplateKwargs: Record<string, unknown> = {
      digits: req.rumble.digits,
      filler: req.rumble.filler,
      verbatim: req.rumble.verbatim,
    };
    if (req.language && req.language !== 'auto') {
      chatTemplateKwargs.language = req.language;
    }

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        temperature: 0,
        max_tokens: 512,
        chat_template_kwargs: chatTemplateKwargs,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`llama-server HTTP ${res.status}: ${errBody}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const rawContent = data.choices?.[0]?.message?.content ?? '';
    return cleanRumbleOutput(rawContent);
  }
}
