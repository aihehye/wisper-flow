import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

export const ARTIFACTS = {
  winRuntime: {
    name: 'llama-b12532-bin-win-vulkan-x64.zip',
    url: 'https://github.com/ggml-org/llama.cpp/releases/download/b12532/llama-b12532-bin-win-vulkan-x64.zip',
    destZip: path.join(root, 'resources', 'runtime', 'llama-b12532-bin-win-vulkan-x64.zip'),
    destDir: path.join(root, 'resources', 'runtime', 'llama-server'),
    checkFile: path.join(root, 'resources', 'runtime', 'llama-server', 'llama-server.exe'),
  },
  linuxRuntime: {
    name: 'llama-b12532-bin-ubuntu-vulkan-x64.tar.gz',
    url: 'https://github.com/ggml-org/llama.cpp/releases/download/b12532/llama-b12532-bin-ubuntu-vulkan-x64.tar.gz',
    destTar: path.join(root, 'resources', 'runtime', 'llama-b12532-bin-ubuntu-vulkan-x64.tar.gz'),
    destDir: path.join(root, 'resources', 'runtime', 'llama-server'),
    checkFile: path.join(root, 'resources', 'runtime', 'llama-server', 'llama-server'),
  },
  model: {
    name: 'Rumble-2-Flash-Q8_0.gguf',
    url: 'https://huggingface.co/AtomicChat/Rumble-2-Flash-GGUF/resolve/main/Rumble-2-Flash-Q8_0.gguf',
    dest: path.join(root, 'resources', 'models', 'rumble-2-flash', 'Rumble-2-Flash-Q8_0.gguf'),
    minBytes: 300_000_000,
  },
  mmproj: {
    name: 'mmproj-Rumble-2-Flash-Q8_0.gguf',
    url: 'https://huggingface.co/AtomicChat/Rumble-2-Flash-GGUF/resolve/main/mmproj-Rumble-2-Flash-Q8_0.gguf',
    dest: path.join(root, 'resources', 'models', 'rumble-2-flash', 'mmproj-Rumble-2-Flash-Q8_0.gguf'),
    minBytes: 180_000_000,
  },
};

async function downloadFile(url, dest, label) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const headRes = await fetch(url, { method: 'HEAD', redirect: 'follow' });
  const expectedSize = Number(headRes.headers.get('content-length') || '0');

  if (fs.existsSync(dest)) {
    const existing = fs.statSync(dest).size;
    if (expectedSize > 0 && existing === expectedSize) {
      console.log(`[skip] ${label} already downloaded (${(existing / 1e6).toFixed(1)} MB)`);
      return;
    }
  }

  console.log(`[download] ${label} from ${url}`);
  const part = `${dest}.part`;
  let downloaded = fs.existsSync(part) ? fs.statSync(part).size : 0;

  const headers = {};
  if (downloaded > 0 && expectedSize > 0 && downloaded < expectedSize) {
    headers.Range = `bytes=${downloaded}-`;
    console.log(`  resuming from ${(downloaded / 1e6).toFixed(1)} MB`);
  } else {
    downloaded = 0;
  }

  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok && res.status !== 206) {
    throw new Error(`HTTP ${res.status} downloading ${url}`);
  }

  const total = expectedSize || downloaded + Number(res.headers.get('content-length') || '0');
  const append = res.status === 206 && downloaded > 0;
  let lastPrint = Date.now();

  const out = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
  const reader = res.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      downloaded += value.byteLength;
      if (!out.write(value)) {
        await new Promise((r) => out.once('drain', r));
      }
      const now = Date.now();
      if (now - lastPrint > 1500) {
        const pct = total > 0 ? ((downloaded / total) * 100).toFixed(1) : '?';
        console.log(`  ${label}: ${(downloaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB (${pct}%)`);
        lastPrint = now;
      }
    }
  } finally {
    await new Promise((resolve, reject) => {
      out.end((err) => (err ? reject(err) : resolve()));
    });
  }

  if (expectedSize > 0 && fs.statSync(part).size !== expectedSize) {
    throw new Error(`Size mismatch for ${label}: got ${fs.statSync(part).size}, expected ${expectedSize}`);
  }
  fs.renameSync(part, dest);
  console.log(`[done] ${label} (${(fs.statSync(dest).size / 1e6).toFixed(1)} MB)`);
}

function extractArchiveWindows(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
    ],
    { stdio: 'inherit' }
  );
}

function extractArchiveLinux(tarPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync('tar', ['-xzf', tarPath, '-C', destDir, '--strip-components=1'], { stdio: 'inherit' });
}

async function main() {
  const isWin = process.platform === 'win32';
  const runtime = isWin ? ARTIFACTS.winRuntime : ARTIFACTS.linuxRuntime;

  if (!fs.existsSync(runtime.checkFile)) {
    const archivePath = isWin ? runtime.destZip : runtime.destTar;
    await downloadFile(runtime.url, archivePath, runtime.name);
    console.log(`[extract] ${runtime.name} -> ${runtime.destDir}`);
    if (isWin) {
      extractArchiveWindows(archivePath, runtime.destDir);
    } else {
      extractArchiveLinux(archivePath, runtime.destDir);
    }
    if (!fs.existsSync(runtime.checkFile)) {
      // Handle nested subdirectory if archive wrapped files
      const entries = fs.readdirSync(runtime.destDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const candidate = path.join(runtime.destDir, entry.name, path.basename(runtime.checkFile));
          if (fs.existsSync(candidate)) {
            for (const f of fs.readdirSync(path.join(runtime.destDir, entry.name))) {
              fs.renameSync(path.join(runtime.destDir, entry.name, f), path.join(runtime.destDir, f));
            }
          }
        }
      }
    }
    if (!fs.existsSync(runtime.checkFile)) {
      throw new Error(`Expected binary missing after extraction: ${runtime.checkFile}`);
    }
    try {
      fs.unlinkSync(archivePath);
    } catch {}
  } else {
    console.log(`[skip] Runtime binary already present: ${runtime.checkFile}`);
  }

  await downloadFile(ARTIFACTS.model.url, ARTIFACTS.model.dest, ARTIFACTS.model.name);
  await downloadFile(ARTIFACTS.mmproj.url, ARTIFACTS.mmproj.dest, ARTIFACTS.mmproj.name);
  console.log('All runtime and model artifacts verified.');
}

if (
  process.argv[1] &&
  fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
