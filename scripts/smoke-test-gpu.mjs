import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const llamaExe = path.join(root, 'resources', 'runtime', 'llama-server', process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
const modelPath = path.join(root, 'resources', 'models', 'rumble-2-flash', 'Rumble-2-Flash-Q8_0.gguf');
const mmprojPath = path.join(root, 'resources', 'models', 'rumble-2-flash', 'mmproj-Rumble-2-Flash-Q8_0.gguf');

function parseVulkanDevices(output) {
  const devices = [];
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^\s*(Vulkan\d+|CUDA\d+|ROCm\d+|Metal\d+)\s*:\s*(.+)$/i);
    if (m) {
      const id = m[1];
      const desc = m[2].trim();
      const lower = desc.toLowerCase();
      const isNvidia = lower.includes('nvidia') || lower.includes('rtx') || lower.includes('gtx') || lower.includes('geforce');
      const isAmdDiscrete = lower.includes('radeon rx') || (lower.includes('amd') && !lower.includes('graphics'));
      const isIntel = lower.includes('intel');
      devices.push({ id, desc, isDiscrete: isNvidia || isAmdDiscrete, isNvidia, isIntel });
    }
  }
  return devices;
}

function makeSpeechWavWindows(text, outWav16k) {
  const rawWav = path.join(os.tmpdir(), `wf-tts-${Date.now()}.wav`);
  const psScript = `
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = 0
$synth.SetOutputToWaveFile('${rawWav.replace(/'/g, "''")}')
$synth.Speak('${text.replace(/'/g, "''")}')
$synth.Dispose()
`;
  execFileSync('powershell', ['-NoProfile', '-Command', psScript], { stdio: 'inherit' });
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', rawWav, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outWav16k], {
    stdio: 'inherit',
  });
  try {
    fs.unlinkSync(rawWav);
  } catch {}
}

function trimTrailingSilenceWav(wavBuf, keepTailMs = 100) {
  // Find 'data' chunk offset
  let pos = 12;
  let dataOffset = -1;
  let dataSize = 0;
  let sampleRate = 16000;
  while (pos + 8 <= wavBuf.length) {
    const id = wavBuf.toString('ascii', pos, pos + 4);
    const size = wavBuf.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      sampleRate = wavBuf.readUInt32LE(pos + 12);
    } else if (id === 'data') {
      dataOffset = pos + 8;
      dataSize = size;
      break;
    }
    pos += 8 + size + (size % 2);
  }
  if (dataOffset < 0) return wavBuf;

  const numSamples = Math.floor(Math.min(dataSize, wavBuf.length - dataOffset) / 2);
  const samples = new Int16Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    samples[i] = wavBuf.readInt16LE(dataOffset + i * 2);
  }

  let firstActive = 0;
  let lastActive = numSamples - 1;
  const threshold = 220; // ~ -43 dBFS
  while (firstActive < numSamples && Math.abs(samples[firstActive]) < threshold) firstActive++;
  while (lastActive > firstActive && Math.abs(samples[lastActive]) < threshold) lastActive--;

  if (firstActive >= lastActive) return wavBuf;

  const padBefore = Math.floor((sampleRate * 80) / 1000);
  const padAfter = Math.floor((sampleRate * keepTailMs) / 1000);
  const startIdx = Math.max(0, firstActive - padBefore);
  const endIdx = Math.min(numSamples, lastActive + padAfter);
  const outSamples = samples.subarray(startIdx, endIdx);

  const outDataSize = outSamples.length * 2;
  const out = Buffer.alloc(44 + outDataSize);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + outDataSize, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(outDataSize, 40);
  for (let i = 0; i < outSamples.length; i++) {
    out.writeInt16LE(outSamples[i], 44 + i * 2);
  }
  return out;
}

async function waitForHealth(url, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) {
        const j = await r.json();
        if (j.status === 'ok') return j;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('llama-server failed health check timeout');
}

async function transcribe(baseUrl, wavBuf, kwargs = {}) {
  const b64 = wavBuf.toString('base64');
  const t0 = performance.now();
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        {
          role: 'user',
          content: [{ type: 'input_audio', input_audio: { data: b64, format: 'wav' } }],
        },
      ],
      temperature: 0,
      max_tokens: 256,
      chat_template_kwargs: {
        language: 'English',
        digits: true,
        filler: false,
        verbatim: true,
        ...kwargs,
      },
    }),
  });
  const elapsedMs = Math.round(performance.now() - t0);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  return { text: text.trim(), elapsedMs };
}

async function main() {
  for (const f of [llamaExe, modelPath, mmprojPath]) {
    if (!fs.existsSync(f)) {
      throw new Error(`Missing required file: ${f}. Run node scripts/download-model.mjs first.`);
    }
  }

  const listOut = execFileSync(llamaExe, ['--list-devices'], { encoding: 'utf8' });
  console.log('=== --list-devices ===\n' + listOut.trim());
  const devices = parseVulkanDevices(listOut);
  const chosen = devices.find((d) => d.isNvidia) || devices.find((d) => d.isDiscrete) || devices[0];
  console.log('Selected GPU device:', chosen);

  const shortWavRaw = path.join(os.tmpdir(), 'wf-smoke-short.wav');
  const longWavRaw = path.join(os.tmpdir(), 'wf-smoke-long.wav');
  makeSpeechWavWindows('Testing local dictation on my graphics card, number 42.', shortWavRaw);
  makeSpeechWavWindows(
    'Hello team, um, please schedule the meeting for Tuesday at 3 PM and send 150 dollars to account 9081.',
    longWavRaw
  );

  const shortBuf = trimTrailingSilenceWav(fs.readFileSync(shortWavRaw));
  const longBuf = trimTrailingSilenceWav(fs.readFileSync(longWavRaw));

  const port = 18945;
  const baseUrl = `http://127.0.0.1:${port}`;
  const args = [
    '-m', modelPath,
    '--mmproj', mmprojPath,
    '-ngl', '99',
    '--host', '127.0.0.1',
    '--port', String(port),
    '--no-webui',
    '-c', '4096',
  ];
  if (chosen) {
    args.push('--device', chosen.id);
  }

  console.log('Spawning llama-server:', llamaExe, args.join(' '));
  const tStart = performance.now();
  const proc = spawn(llamaExe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderrTail = '';
  proc.stderr.on('data', (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-4000);
  });

  try {
    await waitForHealth(baseUrl);
    console.log(`llama-server healthy in ${Math.round(performance.now() - tStart)} ms`);

    // Warmup call + real measurements
    const r1 = await transcribe(baseUrl, shortBuf);
    console.log('[Clip 1 (short, cold/warmup)]', r1);

    const r2 = await transcribe(baseUrl, longBuf);
    console.log('[Clip 2 (long, warm)]', r2);

    const r3 = await transcribe(baseUrl, shortBuf);
    console.log('[Clip 3 (short, warm)]', r3);

    try {
      const nv = execFileSync('nvidia-smi', ['--query-gpu=name,memory.used,memory.total', '--format=csv,noheader'], {
        encoding: 'utf8',
      });
      console.log('=== nvidia-smi ===\n' + nv.trim());
    } catch {}
  } finally {
    proc.kill();
    try {
      fs.unlinkSync(shortWavRaw);
      fs.unlinkSync(longWavRaw);
    } catch {}
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
