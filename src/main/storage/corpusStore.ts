import fs from 'node:fs';
import path from 'node:path';
import type { CorpusExportResult, CorpusStats, HistoryEntry } from '../../shared/types';
import type { AppDatabase } from './db';

export const DEFAULT_CORPUS_MAX_BYTES = 100 * 1024 * 1024; // 100 MB
const CORPUS_SUBDIR = 'corpus';

export interface CorpusStoreOptions {
  maxBytes?: number;
}

export interface ManifestLine {
  audio: string;
  text: string;
  raw_text: string;
  duration_sec: number;
  speech_duration_sec: number;
  id: string;
  language: string;
  corrected: boolean;
}

const COLAB_README = `# Wisper Flow Speech Corpus (Colab LoRA Export)

This folder was exported from Wisper Flow for Whisper / Rumble-2-Flash LoRA fine-tuning.

## Contents

- \`manifest.jsonl\`: One JSON object per line with:
  - \`audio\`: Relative path to the speech-grade Opus clip (\`clips/<id>.webm\`, ~64 kbps)
  - \`text\`: Target transcript (\`corrected_text\` if manually edited, otherwise \`pasted_text\`)
  - \`raw_text\`: Unedited raw ASR transcript
  - \`duration_sec\`: Total clip duration in seconds
  - \`speech_duration_sec\`: Detected active speech duration in seconds
- \`clips/\`: Raw WebM/Opus audio recordings

## Converting Opus (.webm) to 16 kHz Mono WAV in Google Colab

Colab's \`librosa\`, \`torchaudio\`, and HuggingFace \`datasets\` (via \`ffmpeg\`) can decode \`.webm\` Opus directly, or you can pre-convert all clips to 16 kHz mono 16-bit PCM WAV for fastest training throughput:

\`\`\`bash
!apt-get -qq update && apt-get -qq install -y ffmpeg
!mkdir -p wavs
\`\`\`

\`\`\`python
import json
import subprocess
from pathlib import Path

manifest_in = Path("manifest.jsonl")
wav_dir = Path("wavs")
wav_dir.mkdir(exist_ok=True)

rows = [json.loads(line) for line in manifest_in.read_text(encoding="utf-8").splitlines() if line.strip()]
for row in rows:
    src = Path(row["audio"])
    dst = wav_dir / f"{src.stem}.wav"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(dst)],
        check=True,
    )
    row["audio"] = str(dst)

Path("manifest_16k.jsonl").write_text(
    "\\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + ("\\n" if rows else ""),
    encoding="utf-8",
)
print(f"Converted {len(rows)} clips to 16 kHz WAV.")
\`\`\`
`;

function sanitizeClipId(historyId: string): string {
  return historyId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function selectTargetText(entry: HistoryEntry): string {
  const corrected = entry.correctedText?.trim();
  if (corrected) return corrected;
  if (entry.pastedText.trim()) return entry.pastedText;
  if (entry.formattedText.trim()) return entry.formattedText;
  return entry.asrText;
}

export class CorpusStore {
  private readonly userDataDir: string;
  private readonly corpusDir: string;
  private readonly db: AppDatabase;
  private readonly maxBytes: number;

  constructor(userDataDir: string, db: AppDatabase, options?: CorpusStoreOptions) {
    this.userDataDir = path.resolve(userDataDir);
    this.corpusDir = path.join(this.userDataDir, CORPUS_SUBDIR);
    this.db = db;
    this.maxBytes =
      typeof options?.maxBytes === 'number' && Number.isFinite(options.maxBytes) && options.maxBytes > 0
        ? options.maxBytes
        : DEFAULT_CORPUS_MAX_BYTES;
  }

  getCorpusDir(): string {
    return this.corpusDir;
  }

  getMaxBytes(): number {
    return this.maxBytes;
  }

  private resolveClipPath(audioPath: string): string | null {
    const trimmed = audioPath.trim();
    if (!trimmed) return null;

    const normalized = trimmed.replace(/\\/g, '/');
    const candidate = normalized.startsWith(`${CORPUS_SUBDIR}/`)
      ? path.resolve(this.userDataDir, normalized)
      : path.resolve(this.corpusDir, normalized);

    const corpusPrefix = this.corpusDir.endsWith(path.sep)
      ? this.corpusDir
      : `${this.corpusDir}${path.sep}`;
    if (!candidate.startsWith(corpusPrefix)) {
      return null;
    }
    return candidate;
  }

  async saveClip(historyId: string, opusBytes: Uint8Array | Buffer): Promise<string | null> {
    if (!historyId || !opusBytes || opusBytes.byteLength === 0) {
      return null;
    }

    const safeId = sanitizeClipId(historyId);
    if (!safeId) return null;

    const relPath = `${CORPUS_SUBDIR}/${safeId}.webm`;
    const absPath = path.join(this.corpusDir, `${safeId}.webm`);

    try {
      await fs.promises.mkdir(this.corpusDir, { recursive: true });
      const buf = Buffer.isBuffer(opusBytes)
        ? opusBytes
        : Buffer.from(opusBytes.buffer, opusBytes.byteOffset, opusBytes.byteLength);
      await fs.promises.writeFile(absPath, buf);
      this.db.setHistoryAudioPath(historyId, relPath);
      await this.pruneToCap(historyId);
      return relPath;
    } catch {
      return null;
    }
  }

  async pruneToCap(protectedHistoryId?: string): Promise<number> {
    try {
      const entries = this.db
        .listCorpusEntries()
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

      const sized: Array<{ entry: HistoryEntry; filePath: string; size: number }> = [];
      let totalBytes = 0;

      for (const entry of entries) {
        if (!entry.audioPath) continue;
        const filePath = this.resolveClipPath(entry.audioPath);
        if (!filePath) continue;
        try {
          const stat = await fs.promises.stat(filePath);
          if (stat.isFile()) {
            sized.push({ entry, filePath, size: stat.size });
            totalBytes += stat.size;
          }
        } catch {
          // Missing file on disk; skip without throwing
        }
      }

      if (totalBytes <= this.maxBytes) {
        return 0;
      }

      let pruned = 0;
      for (const item of sized) {
        if (totalBytes <= this.maxBytes) break;
        if (protectedHistoryId && item.entry.id === protectedHistoryId) continue;

        try {
          await fs.promises.unlink(item.filePath);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException | null)?.code;
          if (code !== 'ENOENT') {
            continue;
          }
        }
        this.db.setHistoryAudioPath(item.entry.id, null);
        totalBytes -= item.size;
        pruned += 1;
      }

      return pruned;
    } catch {
      return 0;
    }
  }

  async getStats(): Promise<CorpusStats> {
    let clipCount = 0;
    let totalSpeechDurationSec = 0;
    let totalDurationSec = 0;
    let totalBytes = 0;

    try {
      const entries = this.db.listCorpusEntries();
      for (const entry of entries) {
        if (!entry.audioPath) continue;
        const filePath = this.resolveClipPath(entry.audioPath);
        if (!filePath) continue;
        try {
          const stat = await fs.promises.stat(filePath);
          if (stat.isFile()) {
            clipCount += 1;
            totalSpeechDurationSec += entry.speechDurationSec;
            totalDurationSec += entry.durationSec;
            totalBytes += stat.size;
          }
        } catch {
          // Missing clip on disk; ignore
        }
      }
    } catch {
      // Never throw on stats read errors
    }

    return {
      clipCount,
      totalSpeechDurationSec,
      totalDurationSec,
      totalBytes,
      maxBytes: this.maxBytes,
      corpusDir: this.corpusDir,
    };
  }

  async exportColabDataset(outputDir: string): Promise<CorpusExportResult> {
    const resolvedOut = path.resolve(outputDir);
    const clipsDir = path.join(resolvedOut, 'clips');
    await fs.promises.mkdir(clipsDir, { recursive: true });

    const entries = this.db
      .listCorpusEntries()
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const manifestLines: string[] = [];
    let exportedCount = 0;
    let skippedMissingCount = 0;
    let totalBytes = 0;
    let totalSpeechDurationSec = 0;

    for (const entry of entries) {
      if (!entry.audioPath) continue;
      const srcPath = this.resolveClipPath(entry.audioPath);
      if (!srcPath) {
        skippedMissingCount += 1;
        continue;
      }

      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(srcPath);
        if (!stat.isFile()) {
          skippedMissingCount += 1;
          continue;
        }
      } catch {
        skippedMissingCount += 1;
        continue;
      }

      const fileName = path.basename(srcPath);
      const destRel = `clips/${fileName}`;
      const destPath = path.join(clipsDir, fileName);
      await fs.promises.copyFile(srcPath, destPath);

      const line: ManifestLine = {
        audio: destRel,
        text: selectTargetText(entry),
        raw_text: entry.asrText,
        duration_sec: entry.durationSec,
        speech_duration_sec: entry.speechDurationSec,
        id: entry.id,
        language: entry.language,
        corrected: Boolean(entry.correctedText?.trim()),
      };
      manifestLines.push(JSON.stringify(line));
      exportedCount += 1;
      totalBytes += stat.size;
      totalSpeechDurationSec += entry.speechDurationSec;
    }

    const manifestPath = path.join(resolvedOut, 'manifest.jsonl');
    const manifestContent = manifestLines.length > 0 ? `${manifestLines.join('\n')}\n` : '';
    await fs.promises.writeFile(manifestPath, manifestContent, 'utf8');

    const readmePath = path.join(resolvedOut, 'README.md');
    await fs.promises.writeFile(readmePath, COLAB_README, 'utf8');

    return {
      outputDir: resolvedOut,
      manifestPath,
      readmePath,
      exportedCount,
      skippedMissingCount,
      totalBytes,
      totalSpeechDurationSec,
    };
  }
}
