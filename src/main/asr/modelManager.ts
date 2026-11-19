import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const ARTIFACTS_META = {
  winRuntime: {
    name: 'llama-b12532-bin-win-vulkan-x64.zip',
    url: 'https://github.com/ggml-org/llama.cpp/releases/download/b12532/llama-b12532-bin-win-vulkan-x64.zip',
    binaryName: 'llama-server.exe',
    relativeBinaryPath: path.join('runtime', 'llama-server', 'llama-server.exe'),
  },
  linuxRuntime: {
    name: 'llama-b12532-bin-ubuntu-vulkan-x64.tar.gz',
    url: 'https://github.com/ggml-org/llama.cpp/releases/download/b12532/llama-b12532-bin-ubuntu-vulkan-x64.tar.gz',
    binaryName: 'llama-server',
    relativeBinaryPath: path.join('runtime', 'llama-server', 'llama-server'),
  },
  model: {
    name: 'Rumble-2-Flash-Q8_0.gguf',
    url: 'https://huggingface.co/AtomicChat/Rumble-2-Flash-GGUF/resolve/main/Rumble-2-Flash-Q8_0.gguf',
    relativePath: path.join('models', 'rumble-2-flash', 'Rumble-2-Flash-Q8_0.gguf'),
    minBytes: 300_000_000,
  },
  mmproj: {
    name: 'mmproj-Rumble-2-Flash-Q8_0.gguf',
    url: 'https://huggingface.co/AtomicChat/Rumble-2-Flash-GGUF/resolve/main/mmproj-Rumble-2-Flash-Q8_0.gguf',
    relativePath: path.join('models', 'rumble-2-flash', 'mmproj-Rumble-2-Flash-Q8_0.gguf'),
    minBytes: 180_000_000,
  },
} as const;

export interface DownloadProgress {
  file: string;
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
}

export interface ModelPathsInfo {
  modelPath: string;
  mmprojPath: string;
  modelPresent: boolean;
  mmprojPresent: boolean;
  runtimePresent: boolean;
}

interface ElectronAppLike {
  isPackaged: boolean;
  getAppPath(): string;
  getPath(name: string): string;
}

function tryGetElectronApp(): ElectronAppLike | null {
  try {
    // Dynamic require avoids crashing pure Node tests where 'electron' is unavailable.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { app?: ElectronAppLike };
    if (electron && typeof electron === 'object' && electron.app) {
      return electron.app;
    }
  } catch {
    // Pure Node environment
  }
  return null;
}

function findProjectRoot(startDir: string): string {
  let current = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(current, 'package.json'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(startDir);
}

function getBaseStartDir(): string {
  if (typeof __dirname === 'string' && __dirname.length > 0) {
    return __dirname;
  }
  return process.cwd();
}

function isDirectoryWritable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    const probe = path.join(dir, `.write-test-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function getCandidateResourceDirs(customResourcesDir?: string): string[] {
  const dirs: string[] = [];
  const push = (d: string | undefined | null) => {
    if (!d) return;
    const resolved = path.resolve(d);
    if (!dirs.includes(resolved)) dirs.push(resolved);
  };

  if (customResourcesDir) {
    push(customResourcesDir);
    return dirs;
  }

  const app = tryGetElectronApp();
  if (app?.isPackaged) {
    push(path.join(app.getPath('userData'), 'resources'));
    if (process.resourcesPath) {
      push(path.join(process.resourcesPath, 'resources'));
      push(process.resourcesPath);
    }
  } else {
    if (app) {
      push(path.join(app.getAppPath(), 'resources'));
    }
    const rootFromDir = findProjectRoot(getBaseStartDir());
    push(path.join(rootFromDir, 'resources'));
    const rootFromCwd = findProjectRoot(process.cwd());
    push(path.join(rootFromCwd, 'resources'));
    if (app) {
      push(path.join(app.getPath('userData'), 'resources'));
    }
  }

  return dirs;
}

function getWritableResourcesDir(customResourcesDir?: string): string {
  if (customResourcesDir) {
    fs.mkdirSync(customResourcesDir, { recursive: true });
    return path.resolve(customResourcesDir);
  }

  const app = tryGetElectronApp();
  if (app?.isPackaged) {
    const userDataRes = path.join(app.getPath('userData'), 'resources');
    fs.mkdirSync(userDataRes, { recursive: true });
    return userDataRes;
  }

  const devRoot = findProjectRoot(app ? app.getAppPath() : getBaseStartDir());
  const devRes = path.join(devRoot, 'resources');
  if (isDirectoryWritable(devRes)) {
    return devRes;
  }

  const fallback = app
    ? path.join(app.getPath('userData'), 'resources')
    : path.join(os.homedir(), '.wisper-flow', 'resources');
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

function isNonEmptyFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

export function getLlamaServerBinaryPath(customResourcesDir?: string): string | null {
  const runtimeMeta =
    process.platform === 'win32' ? ARTIFACTS_META.winRuntime : ARTIFACTS_META.linuxRuntime;
  const candidates = getCandidateResourceDirs(customResourcesDir);

  for (const resDir of candidates) {
    const primary = path.join(resDir, runtimeMeta.relativeBinaryPath);
    if (isNonEmptyFile(primary)) {
      return primary;
    }
    const direct = path.join(resDir, 'llama-server', runtimeMeta.binaryName);
    if (isNonEmptyFile(direct)) {
      return direct;
    }
  }
  return null;
}

export function getModelPaths(customResourcesDir?: string): ModelPathsInfo {
  const candidates = getCandidateResourceDirs(customResourcesDir);
  const writableDir = getWritableResourcesDir(customResourcesDir);

  let modelPath = path.join(writableDir, ARTIFACTS_META.model.relativePath);
  let modelPresent = false;
  for (const dir of candidates) {
    const candidate = path.join(dir, ARTIFACTS_META.model.relativePath);
    if (isNonEmptyFile(candidate)) {
      modelPath = candidate;
      modelPresent = true;
      break;
    }
  }

  let mmprojPath = path.join(writableDir, ARTIFACTS_META.mmproj.relativePath);
  let mmprojPresent = false;
  for (const dir of candidates) {
    const candidate = path.join(dir, ARTIFACTS_META.mmproj.relativePath);
    if (isNonEmptyFile(candidate)) {
      mmprojPath = candidate;
      mmprojPresent = true;
      break;
    }
  }

  const runtimePresent = getLlamaServerBinaryPath(customResourcesDir) !== null;

  return {
    modelPath,
    mmprojPath,
    modelPresent,
    mmprojPresent,
    runtimePresent,
  };
}

async function downloadFileWithProgress(
  url: string,
  dest: string,
  label: string,
  minExpectedBytes: number,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  let expectedSize = 0;
  try {
    const headRes = await fetch(url, { method: 'HEAD', redirect: 'follow', signal });
    if (headRes.ok) {
      expectedSize = Number(headRes.headers.get('content-length') || '0');
    }
  } catch (err) {
    if (signal?.aborted) throw err;
  }

  if (fs.existsSync(dest)) {
    const existing = fs.statSync(dest).size;
    if (
      (expectedSize > 0 && existing === expectedSize) ||
      (expectedSize === 0 && minExpectedBytes > 0 && existing >= minExpectedBytes)
    ) {
      onProgress({
        file: label,
        downloadedBytes: existing,
        totalBytes: existing,
        percent: 100,
      });
      return;
    }
  }

  const part = `${dest}.part`;
  let downloaded = fs.existsSync(part) ? fs.statSync(part).size : 0;
  const headers: Record<string, string> = {};
  if (downloaded > 0 && expectedSize > 0 && downloaded < expectedSize) {
    headers.Range = `bytes=${downloaded}-`;
  } else {
    downloaded = 0;
  }

  const res = await fetch(url, { headers, redirect: 'follow', signal });
  if (!res.ok && res.status !== 206) {
    throw new Error(`HTTP ${res.status} downloading ${label} from ${url}`);
  }
  if (!res.body) {
    throw new Error(`Empty response body downloading ${label}`);
  }

  const contentLen = Number(res.headers.get('content-length') || '0');
  const append = res.status === 206 && downloaded > 0;
  if (!append) {
    downloaded = 0;
  }
  const totalBytes = expectedSize || (contentLen > 0 ? downloaded + contentLen : 0);

  const out = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
  const reader = res.body.getReader();
  let lastEmit = 0;

  onProgress({
    file: label,
    downloadedBytes: downloaded,
    totalBytes,
    percent: totalBytes > 0 ? Math.min(100, Math.round((downloaded / totalBytes) * 100)) : 0,
  });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      downloaded += value.byteLength;
      if (!out.write(value)) {
        await new Promise<void>((resolve) => out.once('drain', resolve));
      }
      const now = Date.now();
      if (now - lastEmit >= 120) {
        onProgress({
          file: label,
          downloadedBytes: downloaded,
          totalBytes,
          percent: totalBytes > 0 ? Math.min(100, Math.round((downloaded / totalBytes) * 100)) : 0,
        });
        lastEmit = now;
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }

  const partSize = fs.statSync(part).size;
  if (expectedSize > 0 && partSize !== expectedSize) {
    throw new Error(`Size mismatch for ${label}: got ${partSize}, expected ${expectedSize}`);
  }

  if (fs.existsSync(dest)) {
    fs.unlinkSync(dest);
  }
  fs.renameSync(part, dest);

  onProgress({
    file: label,
    downloadedBytes: partSize,
    totalBytes: totalBytes || partSize,
    percent: 100,
  });
}

async function extractRuntimeArchive(
  archivePath: string,
  destDir: string,
  binaryName: string
): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === 'win32') {
    await execFileAsync('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
    ]);
  } else {
    await execFileAsync('tar', ['-xzf', archivePath, '-C', destDir, '--strip-components=1']);
  }

  const expectedBin = path.join(destDir, binaryName);
  if (!fs.existsSync(expectedBin)) {
    const entries = fs.readdirSync(destDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const nestedDir = path.join(destDir, entry.name);
        if (fs.existsSync(path.join(nestedDir, binaryName))) {
          for (const item of fs.readdirSync(nestedDir)) {
            const target = path.join(destDir, item);
            if (!fs.existsSync(target)) {
              fs.renameSync(path.join(nestedDir, item), target);
            }
          }
          break;
        }
      }
    }
  }

  if (!fs.existsSync(expectedBin)) {
    throw new Error(`Runtime binary missing after extraction: ${expectedBin}`);
  }

  if (process.platform !== 'win32') {
    fs.chmodSync(expectedBin, 0o755);
  }
}

export async function downloadModelAndRuntime(
  onProgress: (p: DownloadProgress) => void,
  options?: { signal?: AbortSignal; customResourcesDir?: string }
): Promise<void> {
  const writableDir = getWritableResourcesDir(options?.customResourcesDir);
  const existingBin = getLlamaServerBinaryPath(options?.customResourcesDir);

  if (!existingBin) {
    if (process.platform !== 'win32' && process.platform !== 'linux') {
      throw new Error(`Prebuilt Vulkan llama-server download is only supported on win32/linux (got ${process.platform})`);
    }
    const runtime = process.platform === 'win32' ? ARTIFACTS_META.winRuntime : ARTIFACTS_META.linuxRuntime;
    const archiveDest = path.join(writableDir, 'runtime', runtime.name);
    const runtimeDir = path.join(writableDir, 'runtime', 'llama-server');

    await downloadFileWithProgress(
      runtime.url,
      archiveDest,
      runtime.name,
      0,
      onProgress,
      options?.signal
    );

    await extractRuntimeArchive(archiveDest, runtimeDir, runtime.binaryName);
    try {
      fs.unlinkSync(archiveDest);
    } catch {
      // Ignore cleanup errors
    }
  }

  const paths = getModelPaths(options?.customResourcesDir);
  const modelDest = paths.modelPresent
    ? paths.modelPath
    : path.join(writableDir, ARTIFACTS_META.model.relativePath);
  const mmprojDest = paths.mmprojPresent
    ? paths.mmprojPath
    : path.join(writableDir, ARTIFACTS_META.mmproj.relativePath);

  await downloadFileWithProgress(
    ARTIFACTS_META.model.url,
    modelDest,
    ARTIFACTS_META.model.name,
    ARTIFACTS_META.model.minBytes,
    onProgress,
    options?.signal
  );

  await downloadFileWithProgress(
    ARTIFACTS_META.mmproj.url,
    mmprojDest,
    ARTIFACTS_META.mmproj.name,
    ARTIFACTS_META.mmproj.minBytes,
    onProgress,
    options?.signal
  );
}
