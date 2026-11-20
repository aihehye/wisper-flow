import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore Node --experimental-strip-types requires explicit .ts extension
import { AppDatabase } from '../src/main/storage/db.ts';
// @ts-ignore Node --experimental-strip-types requires explicit .ts extension
import { getTokenUsageStats } from '../src/main/storage/stats.ts';

describe('Token Usage Stats & Dictionary Suggestions DB', () => {
  it('migrates legacy history table safely and computes measured vs estimated token stats', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-token-db-'));
    const dbPath = path.join(tmpDir, 'legacy.sqlite');

    try {
      // Create legacy schema without token columns and insert 1 legacy row
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
        .prepare(
          `INSERT INTO history VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'legacy-1',
          new Date().toISOString(),
          'hello world',
          'Hello world.',
          'Hello world.',
          'chrome.exe',
          'Chrome',
          4.0,
          3.0,
          2,
          400,
          'English',
          'default',
          0
        );
      rawDb.close();

      const appDb = new AppDatabase(dbPath);
      appDb.addHistory({
        timestamp: new Date().toISOString(),
        asrText: 'measured dictation',
        formattedText: 'Measured dictation.',
        pastedText: 'Measured dictation.',
        appName: 'antigravity.exe',
        windowTitle: 'Antigravity',
        durationSec: 2.5,
        speechDurationSec: 2.0,
        numWords: 2,
        e2eLatencyMs: 320,
        language: 'English',
        micDevice: 'default',
        archived: false,
        promptTokens: 120,
        completionTokens: 18,
        totalTokens: 138,
        tokensEstimated: false,
      });

      const history = appDb.listHistory({ includeArchived: true });
      assert.equal(history.length, 2);

      const stats = getTokenUsageStats(history);
      assert.equal(stats.allTime.dictations, 2);
      assert.equal(stats.allTime.measuredDictations, 1);

      // Legacy row: round(4.0 * 25 + 2 * 1.3) = 103
      assert.equal(stats.allTime.totalTokens, 138 + 103);
      assert.equal(stats.today.dictations, 2);
      assert.equal(stats.last7Days.dictations, 2);
      assert.equal(stats.byDay.length, 14);
      assert.equal(stats.byApp.length, 2);
      assert.equal(stats.byApp[0].appName, 'antigravity.exe');
      assert.equal(stats.recent.length, 2);

      const legacyRecent = stats.recent.find((r) => r.id === 'legacy-1');
      assert.equal(legacyRecent?.estimated, true);
      assert.equal(legacyRecent?.totalTokens, 103);

      const measuredRecent = stats.recent.find((r) => r.appName === 'antigravity.exe');
      assert.equal(measuredRecent?.estimated, false);
      assert.equal(measuredRecent?.totalTokens, 138);

      appDb.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('deduplicates, accepts, and dismisses dictionary suggestions', () => {
    const db = new AppDatabase(':memory:');
    db.upsertDictionary({ phrase: 'subagent', replacement: null });

    // Skip if already in dictionary
    assert.equal(
      db.addDictionarySuggestion({ phrase: 'Subagent', replacement: 'sub-agent', appName: 'antigravity.exe' }),
      null
    );

    // Skip identical phrase/replacement
    assert.equal(
      db.addDictionarySuggestion({ phrase: 'Wisper', replacement: 'wisper', appName: 'chrome.exe' }),
      null
    );

    const s1 = db.addDictionarySuggestion({
      phrase: 'whisper flow',
      replacement: 'Wisper Flow',
      appName: 'chrome.exe',
    });
    assert.ok(s1);
    assert.equal(s1.phrase, 'whisper flow');
    assert.equal(s1.replacement, 'Wisper Flow');
    assert.equal(s1.appName, 'chrome.exe');

    // Dedup case-insensitively
    assert.equal(
      db.addDictionarySuggestion({
        phrase: 'Whisper Flow',
        replacement: 'wisper flow',
        appName: 'antigravity.exe',
      }),
      null
    );

    const s2 = db.addDictionarySuggestion({
      phrase: 'tree checks',
      replacement: 'regex',
      appName: 'antigravity.exe',
    });
    assert.ok(s2);
    assert.equal(db.listDictionarySuggestions().length, 2);

    // Accept s1 -> moves to dictionary and deletes from suggestions
    const accepted = db.acceptDictionarySuggestion(s1.id);
    assert.ok(accepted);
    assert.equal(accepted.phrase, 'whisper flow');
    assert.equal(accepted.replacement, 'Wisper Flow');
    assert.equal(db.listDictionarySuggestions().length, 1);
    assert.ok(db.listDictionary().some((d) => d.phrase === 'whisper flow' && d.replacement === 'Wisper Flow'));

    // Dismiss s2
    db.dismissDictionarySuggestion(s2.id);
    assert.equal(db.listDictionarySuggestions().length, 0);

    db.close();
  });
});
