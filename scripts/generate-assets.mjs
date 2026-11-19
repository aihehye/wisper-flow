import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const soundsDir = path.join(root, 'assets', 'sounds');
const iconsDir = path.join(root, 'assets', 'icons');

fs.mkdirSync(soundsDir, { recursive: true });
fs.mkdirSync(iconsDir, { recursive: true });

// ---- WAV Synthesizer (48 kHz 16-bit stereo PCM) ----
const SAMPLE_RATE = 48000;

function writeWavStereo(filePath, leftSamples, rightSamples = leftSamples) {
  const numSamples = leftSamples.length;
  const numChannels = 2;
  const bitsPerSample = 16;
  const byteRate = SAMPLE_RATE * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = numSamples * blockAlign;

  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const l = Math.max(-1, Math.min(1, leftSamples[i]));
    const r = Math.max(-1, Math.min(1, rightSamples[i]));
    buf.writeInt16LE(Math.round(l * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(r * 32767), 44 + i * 4 + 2);
  }
  fs.writeFileSync(filePath, buf);
}

function synthTone(durationMs, generator) {
  const n = Math.floor((SAMPLE_RATE * durationMs) / 1000);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const progress = i / Math.max(1, n - 1);
    samples[i] = generator(t, progress);
  }
  return samples;
}

function envSmooth(progress, attackFrac = 0.08, releaseFrac = 0.4) {
  let env = 1;
  if (progress < attackFrac) {
    env = Math.sin((progress / attackFrac) * (Math.PI / 2));
  } else if (progress > 1 - releaseFrac) {
    const r = (1 - progress) / releaseFrac;
    env = Math.sin(r * (Math.PI / 2));
  }
  return env;
}

function mixSegments(totalMs, segments) {
  const n = Math.floor((SAMPLE_RATE * totalMs) / 1000);
  const out = new Float32Array(n);
  for (const seg of segments) {
    const offset = Math.floor((SAMPLE_RATE * seg.startMs) / 1000);
    const data = synthTone(seg.durationMs, seg.fn);
    for (let i = 0; i < data.length && offset + i < n; i++) {
      out[offset + i] += data[i];
    }
  }
  for (let i = 0; i < n; i++) {
    out[i] = Math.tanh(out[i]);
  }
  return out;
}

// 1. dictation-start.wav (~155 ms soft rising pop)
writeWavStereo(
  path.join(soundsDir, 'dictation-start.wav'),
  synthTone(155, (t, p) => {
    const freq = 520 + 360 * Math.pow(p, 0.7);
    const env = envSmooth(p, 0.06, 0.55) * 0.28;
    return (Math.sin(2 * Math.PI * freq * t) + 0.2 * Math.sin(4 * Math.PI * freq * t)) * env;
  })
);

// 2. dictation-stop.wav (~210 ms soft falling pop)
writeWavStereo(
  path.join(soundsDir, 'dictation-stop.wav'),
  synthTone(210, (t, p) => {
    const freq = 740 - 300 * Math.pow(p, 0.8);
    const env = envSmooth(p, 0.05, 0.6) * 0.26;
    return (Math.sin(2 * Math.PI * freq * t) + 0.15 * Math.sin(4 * Math.PI * freq * t)) * env;
  })
);

// 3. popo-lock.wav (~180 ms crisp double-note lock chime)
writeWavStereo(
  path.join(soundsDir, 'popo-lock.wav'),
  mixSegments(180, [
    {
      startMs: 0,
      durationMs: 80,
      fn: (t, p) => Math.sin(2 * Math.PI * 660 * t) * envSmooth(p, 0.08, 0.5) * 0.24,
    },
    {
      startMs: 75,
      durationMs: 105,
      fn: (t, p) => Math.sin(2 * Math.PI * 988 * t) * envSmooth(p, 0.08, 0.65) * 0.26,
    },
  ])
);

// 4. paste.wav (~140 ms subtle tactile tick)
writeWavStereo(
  path.join(soundsDir, 'paste.wav'),
  synthTone(140, (t, p) => {
    const freq = 1040 - 280 * p;
    const decay = Math.exp(-p * 5.2);
    return Math.sin(2 * Math.PI * freq * t) * envSmooth(p, 0.04, 0.4) * decay * 0.22;
  })
);

// 5. error.wav (~420 ms gentle low two-note alert)
writeWavStereo(
  path.join(soundsDir, 'error.wav'),
  mixSegments(420, [
    {
      startMs: 0,
      durationMs: 180,
      fn: (t, p) => (Math.sin(2 * Math.PI * 330 * t) + 0.25 * Math.sin(2 * Math.PI * 495 * t)) * envSmooth(p, 0.06, 0.6) * 0.25,
    },
    {
      startMs: 160,
      durationMs: 260,
      fn: (t, p) => (Math.sin(2 * Math.PI * 247 * t) + 0.25 * Math.sin(2 * Math.PI * 370 * t)) * envSmooth(p, 0.06, 0.7) * 0.26,
    },
  ])
);

// 6. alert.wav (~480 ms warm notification chime)
writeWavStereo(
  path.join(soundsDir, 'alert.wav'),
  mixSegments(480, [
    {
      startMs: 0,
      durationMs: 240,
      fn: (t, p) => Math.sin(2 * Math.PI * 587.33 * t) * envSmooth(p, 0.05, 0.65) * 0.22,
    },
    {
      startMs: 120,
      durationMs: 360,
      fn: (t, p) => Math.sin(2 * Math.PI * 587.33 * t) * envSmooth(p, 0.05, 0.7) * 0.22,
    },
  ])
);

// 7. success.wav (~480 ms bright C-G fifth chime)
writeWavStereo(
  path.join(soundsDir, 'success.wav'),
  mixSegments(480, [
    {
      startMs: 0,
      durationMs: 220,
      fn: (t, p) => Math.sin(2 * Math.PI * 523.25 * t) * envSmooth(p, 0.05, 0.6) * 0.22,
    },
    {
      startMs: 110,
      durationMs: 370,
      fn: (t, p) => Math.sin(2 * Math.PI * 783.99 * t) * envSmooth(p, 0.05, 0.72) * 0.24,
    },
  ])
);

// 8. achievement.wav (~850 ms gentle 3-note milestone arpeggio)
writeWavStereo(
  path.join(soundsDir, 'achievement.wav'),
  mixSegments(850, [
    {
      startMs: 0,
      durationMs: 280,
      fn: (t, p) => Math.sin(2 * Math.PI * 523.25 * t) * envSmooth(p, 0.05, 0.65) * 0.2,
    },
    {
      startMs: 120,
      durationMs: 300,
      fn: (t, p) => Math.sin(2 * Math.PI * 659.25 * t) * envSmooth(p, 0.05, 0.65) * 0.2,
    },
    {
      startMs: 240,
      durationMs: 600,
      fn: (t, p) => (Math.sin(2 * Math.PI * 783.99 * t) + 0.3 * Math.sin(2 * Math.PI * 1046.5 * t)) * envSmooth(p, 0.05, 0.75) * 0.22,
    },
  ])
);

// ---- Pure-JS RGBA -> PNG & ICO Icon Generator ----
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter None
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeIco(pngBuffers, sizes) {
  const count = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // ICON
  header.writeUInt16LE(count, 4);

  const entries = [];
  let offset = 6 + count * 16;
  for (let i = 0; i < count; i++) {
    const size = sizes[i];
    const png = pngBuffers[i];
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...pngBuffers]);
}

function drawRoundedIcon(size, bgColor, fgColor, border = false) {
  const buf = Buffer.alloc(size * size * 4);
  const radius = size * 0.26;
  const half = size / 2;

  const setPx = (x, y, r, g, b, a) => {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const idx = (y * size + x) * 4;
    const alpha = Math.max(0, Math.min(255, Math.round(a)));
    const srcA = alpha / 255;
    const dstA = buf[idx + 3] / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA <= 0) return;
    buf[idx] = Math.round((r * srcA + buf[idx] * dstA * (1 - srcA)) / outA);
    buf[idx + 1] = Math.round((g * srcA + buf[idx + 1] * dstA * (1 - srcA)) / outA);
    buf[idx + 2] = Math.round((b * srcA + buf[idx + 2] * dstA * (1 - srcA)) / outA);
    buf[idx + 3] = Math.round(outA * 255);
  };

  // Rounded square background
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.max(Math.abs(x + 0.5 - half) - (half - radius - 1), 0);
      const dy = Math.max(Math.abs(y + 0.5 - half) - (half - radius - 1), 0);
      const dist = Math.hypot(dx, dy) - radius;
      if (dist <= 0.6) {
        const cov = Math.max(0, Math.min(1, 0.6 - dist));
        let [r, g, b] = bgColor;
        if (border && dist > -size * 0.04) {
          r = Math.min(255, r + 40);
          g = Math.min(255, g + 40);
          b = Math.min(255, b + 40);
        }
        setPx(x, y, r, g, b, cov * 255);
      }
    }
  }

  // 5-bar waveform glyph in the center
  const heights = [0.24, 0.44, 0.62, 0.44, 0.24];
  const barW = Math.max(2, Math.round(size * 0.085));
  const gap = Math.max(1, Math.round(size * 0.065));
  const totalW = heights.length * barW + (heights.length - 1) * gap;
  const startX = Math.round((size - totalW) / 2);

  for (let b = 0; b < heights.length; b++) {
    const bh = Math.max(barW, Math.round(size * heights[b]));
    const bx = startX + b * (barW + gap);
    const by = Math.round((size - bh) / 2);
    const rCap = barW / 2;
    for (let y = by; y < by + bh; y++) {
      for (let x = bx; x < bx + barW; x++) {
        const cx = bx + rCap;
        const cyTop = by + rCap;
        const cyBot = by + bh - rCap;
        let alpha = 255;
        if (y + 0.5 < cyTop) {
          const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cyTop);
          if (d > rCap + 0.5) alpha = 0;
        } else if (y + 0.5 > cyBot) {
          const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cyBot);
          if (d > rCap + 0.5) alpha = 0;
        }
        if (alpha > 0) setPx(x, y, fgColor[0], fgColor[1], fgColor[2], alpha);
      }
    }
  }

  return encodePng(size, size, buf);
}

// Tray icons (dark badge with crisp white waveform + active emerald badge)
const trayPng16 = drawRoundedIcon(16, [18, 18, 22], [250, 250, 250], false);
const trayPng32 = drawRoundedIcon(32, [18, 18, 22], [250, 250, 250], true);
const trayActive32 = drawRoundedIcon(32, [16, 145, 90], [255, 255, 255], false);
fs.writeFileSync(path.join(iconsDir, 'tray.png'), trayPng32);
fs.writeFileSync(path.join(iconsDir, 'tray-16.png'), trayPng16);
fs.writeFileSync(path.join(iconsDir, 'tray-active.png'), trayActive32);

// App icons (PNG + multi-size ICO)
const app256 = drawRoundedIcon(256, [15, 16, 20], [244, 244, 246], true);
const app128 = drawRoundedIcon(128, [15, 16, 20], [244, 244, 246], true);
const app48 = drawRoundedIcon(48, [15, 16, 20], [244, 244, 246], true);
const app32 = drawRoundedIcon(32, [15, 16, 20], [244, 244, 246], true);
const app16 = drawRoundedIcon(16, [15, 16, 20], [244, 244, 246], false);

fs.writeFileSync(path.join(iconsDir, 'app.png'), app256);
fs.writeFileSync(
  path.join(iconsDir, 'app.ico'),
  encodeIco([app16, app32, app48, app128, app256], [16, 32, 48, 128, 256])
);

console.log('Generated 8 WAV cues in', soundsDir);
console.log('Generated icons in', iconsDir);
