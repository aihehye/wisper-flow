import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
// @ts-ignore Node --experimental-strip-types requires explicit .ts extension
import { extractCorrectedFullText, scheduleCorrectionWatch } from '../src/main/pipeline/correctionWatcher.ts';
// @ts-ignore Node --experimental-strip-types requires explicit .ts extension
import { DictationStateMachine } from '../src/main/stateMachine.ts';
// @ts-ignore Node --experimental-strip-types requires explicit .ts extension
import { CorpusStore } from '../src/main/storage/corpusStore.ts';
// @ts-ignore Node --experimental-strip-types requires explicit .ts extension
import { AppDatabase } from '../src/main/storage/db.ts';
import type { AsrBackend, TranscribeRequest, TranscribeResult } from '../src/main/asr/types';
import type { PlatformBridge } from '../src/main/platform/types';
import type { AppSettings, ModelStatus, OmarchyEnvironment } from '../src/shared/types';

function makeTempDir(prefix = 'wf-corpus-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function addSampleHistory(
  db: AppDatabase,
  overrides: Partial<Parameters<AppDatabase['addHistory']>[0]> = {}
) {
  return db.addHistory({
    timestamp: '2026-11-20T10:00:00.000Z',
    asrText: 'hello world raw',
    formattedText: 'Hello world.',
    pastedText: 'Hello world.',
    appName: 'notepad.exe',
    windowTitle: 'Notepad',
    durationSec: 3.2,
    speechDurationSec: 2.1,
    numWords: 2,
    e2eLatencyMs: 210,
    language: 'English',
    micDevice: 'default',
    archived: false,
    ...overrides,
  });
}

describe('AppDatabase corpus migrations & helpers', () => {
  it('idempotently migrates legacy history table and supports audioPath / correctedText helpers', () => {
    const tmpDir = makeTempDir('wf-corpus-db-');
    const dbPath = path.join(tmpDir, 'legacy.sqlite');

    try {
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec(`
        CREATE TABLE history (
          id TEXT PRIMARY KEY,
          timestamp TEXT NOT NULL,
          asr_text TEXT NOT NULL,
          formatted_text TEXT NOT NULL,
          pasted_text TEXT NOT NULL,
          app_name TEXT NOT NULL,
          window_title TEXT NOT NULL,
          duration_sec REAL NOT NULL,
          speech_duration_sec REAL NOT NULL,
          num_words INTEGER NOT NULL,
          e2e_latency_ms INTEGER NOT NULL,
          language TEXT NOT NULL,
          mic_device TEXT NOT NULL,
          archived INTEGER NOT NULL DEFAULT 0
        );
      `);
      rawDb
        .prepare('INSERT INTO history VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          'legacy-row-1',
          '2026-11-19T09:00:00.000Z',
          'legacy asr',
          'Legacy asr.',
          'Legacy asr.',
          'code.exe',
          'VS Code',
          2.0,
          1.5,
          2,
          180,
          'English',
          'default',
          0
        );
      rawDb.close();

      // First open runs migrations
      const db1 = new AppDatabase(dbPath);
      const initialCorpus = db1.listCorpusEntries();
      assert.equal(initialCorpus.length, 0);

      db1.setHistoryAudioPath('legacy-row-1', 'corpus/legacy-row-1.webm');
      db1.setHistoryCorrectedText('legacy-row-1', 'Legacy ASR.');
      db1.close();

      // Second open must be idempotent and preserve migrated data
      const db2 = new AppDatabase(dbPath);
      const corpus = db2.listCorpusEntries();
      assert.equal(corpus.length, 1);
      assert.equal(corpus[0].id, 'legacy-row-1');
      assert.equal(corpus[0].audioPath, 'corpus/legacy-row-1.webm');
      assert.equal(corpus[0].correctedText, 'Legacy ASR.');
      db2.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('CorpusStore', () => {
  it('saves Opus clips under <userData>/corpus/<id>.webm and computes accurate stats', async () => {
    const tmpDir = makeTempDir();
    const db = new AppDatabase(':memory:');
    const store = new CorpusStore(tmpDir, db);

    try {
      const h1 = addSampleHistory(db, {
        timestamp: '2026-11-20T10:00:00.000Z',
        durationSec: 4.0,
        speechDurationSec: 2.5,
      });
      const h2 = addSampleHistory(db, {
        timestamp: '2026-11-20T10:01:00.000Z',
        durationSec: 6.0,
        speechDurationSec: 3.5,
      });
      // Entry without audio clip should not be counted
      addSampleHistory(db, {
        timestamp: '2026-11-20T10:02:00.000Z',
        durationSec: 10.0,
        speechDurationSec: 8.0,
      });

      const bytes1 = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
      const bytes2 = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 5, 6, 7, 8, 9, 10]);

      const rel1 = await store.saveClip(h1.id, bytes1);
      const rel2 = await store.saveClip(h2.id, bytes2);

      assert.equal(rel1, `corpus/${h1.id}.webm`);
      assert.equal(rel2, `corpus/${h2.id}.webm`);
      assert.deepEqual(
        fs.readFileSync(path.join(tmpDir, 'corpus', `${h1.id}.webm`)),
        Buffer.from(bytes1)
      );
      assert.deepEqual(
        fs.readFileSync(path.join(tmpDir, 'corpus', `${h2.id}.webm`)),
        bytes2
      );

      // Empty buffers are safely ignored
      assert.equal(await store.saveClip(h1.id, new Uint8Array(0)), null);

      const stats = await store.getStats();
      assert.equal(stats.clipCount, 2);
      assert.equal(stats.totalSpeechDurationSec, 6.0);
      assert.equal(stats.totalDurationSec, 10.0);
      assert.equal(stats.totalBytes, bytes1.byteLength + bytes2.byteLength);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('prunes oldest clips when soft storage cap is exceeded and never crashes on disk errors', async () => {
    const tmpDir = makeTempDir();
    const db = new AppDatabase(':memory:');
    const store = new CorpusStore(tmpDir, db, { maxBytes: 450 });

    try {
      const h1 = addSampleHistory(db, { timestamp: '2026-11-20T10:00:00.000Z', speechDurationSec: 1.0 });
      const h2 = addSampleHistory(db, { timestamp: '2026-11-20T10:01:00.000Z', speechDurationSec: 2.0 });
      const h3 = addSampleHistory(db, { timestamp: '2026-11-20T10:02:00.000Z', speechDurationSec: 3.0 });

      await store.saveClip(h1.id, new Uint8Array(200).fill(1));
      await store.saveClip(h2.id, new Uint8Array(200).fill(2));
      await store.saveClip(h3.id, new Uint8Array(200).fill(3));

      // 600 > 450 => oldest (h1) pruned, leaving h2 + h3 = 400 bytes
      assert.equal(fs.existsSync(path.join(tmpDir, 'corpus', `${h1.id}.webm`)), false);
      assert.equal(fs.existsSync(path.join(tmpDir, 'corpus', `${h2.id}.webm`)), true);
      assert.equal(fs.existsSync(path.join(tmpDir, 'corpus', `${h3.id}.webm`)), true);

      const corpus = db.listCorpusEntries();
      assert.deepEqual(
        corpus.map((e) => e.id),
        [h2.id, h3.id]
      );

      const stats = await store.getStats();
      assert.equal(stats.clipCount, 2);
      assert.equal(stats.totalBytes, 400);
      assert.equal(stats.totalSpeechDurationSec, 5.0);

      // Disk error safety: if <userData>/corpus is blocked by a regular file, saveClip returns null without throwing
      const badDir = makeTempDir('wf-corpus-bad-');
      try {
        fs.writeFileSync(path.join(badDir, 'corpus'), 'not-a-directory');
        const badStore = new CorpusStore(badDir, db);
        const h4 = addSampleHistory(db, { timestamp: '2026-11-20T10:03:00.000Z' });
        const result = await badStore.saveClip(h4.id, new Uint8Array([1, 2, 3]));
        assert.equal(result, null);
      } finally {
        fs.rmSync(badDir, { recursive: true, force: true });
      }
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('exports Colab-ready dataset folder with manifest.jsonl, copied .webm clips, and ffmpeg README', async () => {
    const tmpDir = makeTempDir();
    const exportDir = path.join(tmpDir, 'colab-export');
    const db = new AppDatabase(':memory:');
    const store = new CorpusStore(tmpDir, db);

    try {
      const h1 = addSampleHistory(db, {
        timestamp: '2026-11-20T10:00:00.000Z',
        asrText: 'open whisper flow settings',
        formattedText: 'Open whisper flow settings.',
        pastedText: 'Open whisper flow settings.',
        durationSec: 3.5,
        speechDurationSec: 2.4,
      });
      const h2 = addSampleHistory(db, {
        timestamp: '2026-11-20T10:01:00.000Z',
        asrText: 'deploy to kubernetes cluster',
        formattedText: 'Deploy to kubernetes cluster.',
        pastedText: 'Deploy to kubernetes cluster.',
        durationSec: 4.2,
        speechDurationSec: 3.1,
      });
      const hMissing = addSampleHistory(db, {
        timestamp: '2026-11-20T10:02:00.000Z',
        asrText: 'missing clip',
        formattedText: 'Missing clip.',
        pastedText: 'Missing clip.',
      });

      const clip1 = Buffer.from('opus-clip-one');
      const clip2 = Buffer.from('opus-clip-two');
      await store.saveClip(h1.id, clip1);
      await store.saveClip(h2.id, clip2);
      db.setHistoryCorrectedText(h1.id, 'Open Wisper Flow settings.');
      // Simulate DB entry whose file was removed from disk
      db.setHistoryAudioPath(hMissing.id, `corpus/${hMissing.id}.webm`);

      const res = await store.exportColabDataset(exportDir);
      assert.equal(res.exportedCount, 2);
      assert.equal(res.skippedMissingCount, 1);
      assert.equal(res.totalBytes, clip1.byteLength + clip2.byteLength);
      assert.equal(Math.round(res.totalSpeechDurationSec * 10) / 10, 5.5);
      assert.ok(fs.existsSync(res.manifestPath));
      assert.ok(fs.existsSync(res.readmePath));

      const readme = fs.readFileSync(res.readmePath, 'utf8');
      assert.match(readme, /ffmpeg/i);
      assert.match(readme, /16000/);

      const lines = fs
        .readFileSync(res.manifestPath, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      assert.equal(lines.length, 2);

      assert.equal(lines[0].audio, `clips/${h1.id}.webm`);
      assert.equal(lines[0].text, 'Open Wisper Flow settings.');
      assert.equal(lines[0].raw_text, 'open whisper flow settings');
      assert.equal(lines[0].duration_sec, 3.5);
      assert.equal(lines[0].speech_duration_sec, 2.4);
      assert.equal(lines[0].corrected, true);

      assert.equal(lines[1].audio, `clips/${h2.id}.webm`);
      assert.equal(lines[1].text, 'Deploy to kubernetes cluster.');
      assert.equal(lines[1].raw_text, 'deploy to kubernetes cluster');
      assert.equal(lines[1].corrected, false);

      assert.deepEqual(
        fs.readFileSync(path.join(exportDir, String(lines[0].audio))),
        clip1
      );
      assert.deepEqual(
        fs.readFileSync(path.join(exportDir, String(lines[1].audio))),
        clip2
      );
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('StateMachine & CorrectionWatcher corpus integration', () => {
  it('extracts corrected full text from standalone and embedded edits', () => {
    assert.equal(
      extractCorrectedFullText('I use whisper flow daily.', 'I use Wisper Flow daily.'),
      'I use Wisper Flow daily.'
    );
    assert.equal(
      extractCorrectedFullText(
        'We should migrate the sqlite database to wal mode soon.',
        'Hey team,\n\nWe should migrate the SQLite database to WAL mode soon!\n\nThanks'
      ),
      'We should migrate the SQLite database to WAL mode soon!'
    );
  });

  it('saves Opus clip on dictation and updates corrected_text when correctionWatcher detects an edit', async () => {
    const tmpDir = makeTempDir('wf-corpus-sm-');
    const db = new AppDatabase(path.join(tmpDir, 'flow.sqlite'), 'win32');
    const corpusStore = new CorpusStore(tmpDir, db);

    let pollCount = 0;
    const platform: PlatformBridge = {
      kind: 'win32',
      async start() {},
      async stop() {},
      async updateShortcuts() {},
      async startShortcutCapture() {},
      async stopShortcutCapture() {},
      async getForegroundApp() {
        return { processName: 'notepad.exe', title: 'Untitled', isTerminal: false };
      },
      async pasteText() {
        return { ok: true };
      },
      async copyText() {
        return { ok: true };
      },
      async muteOtherAudio() {},
      async unmuteOtherAudio() {},
      async getOmarchyEnvironment() {
        return {} as OmarchyEnvironment;
      },
      getHelperPids() {
        return [];
      },
      async readFocusedText() {
        pollCount += 1;
        if (pollCount === 1) {
          return { ok: true, text: 'I use whisper flow daily', processName: 'notepad.exe' };
        }
        return { ok: true, text: 'I use Wisper Flow daily', processName: 'notepad.exe' };
      },
    };

    const asr: AsrBackend = {
      id: 'llama-server',
      async start() {},
      async stop() {},
      async restart() {},
      async listDevices() {
        return [];
      },
      getStatus(): ModelStatus {
        return {
          state: 'ready',
          engine: 'llama-server',
          modelName: 'rumble-2-flash',
          modelPresent: true,
          mmprojPresent: true,
          runtimePresent: true,
          activeDeviceId: 'Vulkan0',
          activeDeviceName: 'Mock GPU',
          availableDevices: [],
        };
      },
      async transcribe(_req: TranscribeRequest): Promise<TranscribeResult> {
        return {
          rawText: 'I use whisper flow daily',
          detectedLanguage: 'English',
          asrLatencyMs: 25,
        };
      },
      onStatusChange() {
        return () => {};
      },
    };

    let capturedSessionId = '';
    const sm = new DictationStateMachine({
      getSettings: (): AppSettings => db.getSettings(),
      platform,
      asr,
      db,
      corpusStore,
      sendHudState: () => {},
      sendRecordCommand: (cmd) => {
        if (cmd.action === 'start') capturedSessionId = cmd.sessionId;
      },
      playSound: () => {},
      onHistoryAdded: () => {},
    });

    try {
      await sm.handleHandsFreeToggle();
      assert.ok(capturedSessionId);

      const opusPayload = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 9, 8, 7, 6]);
      await sm.handleAudioSubmitted({
        sessionId: capturedSessionId,
        wavBuffer: Buffer.alloc(64, 1),
        opusBuffer: opusPayload,
        speechDurationMs: 1400,
        totalDurationMs: 2000,
        isSilent: false,
      });

      // Allow fire-and-forget clip write to finish
      await new Promise((r) => setTimeout(r, 40));

      const corpus = db.listCorpusEntries();
      assert.equal(corpus.length, 1);
      assert.equal(corpus[0].audioPath, `corpus/${corpus[0].id}.webm`);
      assert.deepEqual(
        fs.readFileSync(path.join(tmpDir, 'corpus', `${corpus[0].id}.webm`)),
        opusPayload
      );

      // Verify scheduleCorrectionWatch updates corrected_text on the history entry
      let watched = 0;
      scheduleCorrectionWatch(
        {
          pastedText: 'I use whisper flow daily',
          historyId: corpus[0].id,
          targetAppName: 'notepad.exe',
          pollDelaysMs: [10, 25, 45],
          readFocusedText: async () => {
            watched += 1;
            if (watched === 1) {
              return { ok: true, text: 'I use whisper flow daily', processName: 'notepad.exe' };
            }
            return { ok: true, text: 'I use Wisper Flow daily', processName: 'notepad.exe' };
          },
          onCorrectedText: ({ historyId, correctedText }) => {
            if (historyId) db.setHistoryCorrectedText(historyId, correctedText);
          },
        },
        () => {}
      );

      await new Promise((r) => setTimeout(r, 90));
      const updated = db.listCorpusEntries();
      assert.equal(updated[0].correctedText, 'I use Wisper Flow daily');
    } finally {
      sm.dispose();
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
