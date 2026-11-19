import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
// @ts-ignore Node --experimental-strip-types requires explicit .ts extension
import { createDefaultSettings } from '../../shared/defaults.ts';
import type {
  AppSettings,
  DictionaryEntry,
  HistoryEntry,
  PlatformKind,
  RegexRuleEntry,
  SnippetEntry,
} from '../../shared/types';

const SETTINGS_KEY = 'app_settings';

interface DictionaryRow {
  id: string;
  phrase: string;
  replacement: string | null;
  enabled: number;
  frequency_used: number;
  last_used: string | null;
  created_at: string;
  modified_at: string;
}

interface SnippetRow {
  id: string;
  trigger: string;
  expansion: string;
  exact_only: number;
  enabled: number;
  frequency_used: number;
  last_used: string | null;
  created_at: string;
  modified_at: string;
}

interface RegexRuleRow {
  id: string;
  name: string;
  pattern: string;
  flags: string;
  replacement: string;
  enabled: number;
  sort_order: number;
  created_at: string;
  modified_at: string;
}

interface HistoryRow {
  id: string;
  timestamp: string;
  asr_text: string;
  formatted_text: string;
  pasted_text: string;
  app_name: string;
  window_title: string;
  duration_sec: number;
  speech_duration_sec: number;
  num_words: number;
  e2e_latency_ms: number;
  language: string;
  mic_device: string;
  archived: number;
}

function mapDictionaryRow(row: DictionaryRow): DictionaryEntry {
  return {
    id: row.id,
    phrase: row.phrase,
    replacement: row.replacement,
    enabled: Boolean(row.enabled),
    frequencyUsed: row.frequency_used,
    lastUsed: row.last_used,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
  };
}

function mapSnippetRow(row: SnippetRow): SnippetEntry {
  return {
    id: row.id,
    trigger: row.trigger,
    expansion: row.expansion,
    exactOnly: Boolean(row.exact_only),
    enabled: Boolean(row.enabled),
    frequencyUsed: row.frequency_used,
    lastUsed: row.last_used,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
  };
}

function mapRegexRuleRow(row: RegexRuleRow): RegexRuleEntry {
  return {
    id: row.id,
    name: row.name,
    pattern: row.pattern,
    flags: row.flags,
    replacement: row.replacement,
    enabled: Boolean(row.enabled),
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
  };
}

function mapHistoryRow(row: HistoryRow): HistoryEntry {
  return {
    id: row.id,
    timestamp: row.timestamp,
    asrText: row.asr_text,
    formattedText: row.formatted_text,
    pastedText: row.pasted_text,
    appName: row.app_name,
    windowTitle: row.window_title,
    durationSec: row.duration_sec,
    speechDurationSec: row.speech_duration_sec,
    numWords: row.num_words,
    e2eLatencyMs: row.e2e_latency_ms,
    language: row.language,
    micDevice: row.mic_device,
    archived: Boolean(row.archived),
  };
}

function mergeSettings(base: AppSettings, patch?: Partial<AppSettings> | null): AppSettings {
  if (!patch) {
    return {
      ...base,
      shortcuts: { ...base.shortcuts },
      rumble: { ...base.rumble },
      cleanup: {
        ...base.cleanup,
        allLowercaseApps: [...base.cleanup.allLowercaseApps],
      },
    };
  }

  return {
    ...base,
    ...patch,
    shortcuts: {
      ...base.shortcuts,
      ...(patch.shortcuts ?? {}),
    },
    rumble: {
      ...base.rumble,
      ...(patch.rumble ?? {}),
    },
    cleanup: {
      ...base.cleanup,
      ...(patch.cleanup ?? {}),
      allLowercaseApps: Array.isArray(patch.cleanup?.allLowercaseApps)
        ? [...patch.cleanup.allLowercaseApps]
        : [...base.cleanup.allLowercaseApps],
    },
  };
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&');
}

export class AppDatabase {
  private readonly db: DatabaseSync;
  private readonly defaultPlatform?: PlatformKind;
  private closed = false;

  constructor(dbPath: string, defaultPlatform?: PlatformKind) {
    this.defaultPlatform = defaultPlatform;
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dictionary (
        id TEXT PRIMARY KEY,
        phrase TEXT NOT NULL,
        replacement TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        frequency_used INTEGER NOT NULL DEFAULT 0,
        last_used TEXT,
        created_at TEXT NOT NULL,
        modified_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS snippets (
        id TEXT PRIMARY KEY,
        trigger TEXT NOT NULL,
        expansion TEXT NOT NULL,
        exact_only INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        frequency_used INTEGER NOT NULL DEFAULT 0,
        last_used TEXT,
        created_at TEXT NOT NULL,
        modified_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS regex_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        pattern TEXT NOT NULL,
        flags TEXT NOT NULL DEFAULT 'giu',
        replacement TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        modified_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS history (
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

      CREATE INDEX IF NOT EXISTS idx_history_timestamp ON history (timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_regex_sort_order ON regex_rules (sort_order ASC);
    `);
  }

  private runInTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getSettings(): AppSettings {
    const defaults = createDefaultSettings(this.defaultPlatform);
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(SETTINGS_KEY) as { value: string } | undefined;

    if (!row) {
      return mergeSettings(defaults);
    }

    try {
      const parsed = JSON.parse(row.value) as Partial<AppSettings>;
      return mergeSettings(defaults, parsed);
    } catch {
      return mergeSettings(defaults);
    }
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const current = this.getSettings();
    const updated = mergeSettings(current, patch);
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(SETTINGS_KEY, JSON.stringify(updated));
    return updated;
  }

  listDictionary(): DictionaryEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM dictionary ORDER BY frequency_used DESC, created_at DESC')
      .all() as unknown as DictionaryRow[];
    return rows.map(mapDictionaryRow);
  }

  upsertDictionary(entry: Partial<DictionaryEntry> & { phrase: string }): DictionaryEntry {
    const now = new Date().toISOString();
    const id = entry.id?.trim() || crypto.randomUUID();
    const existing = this.db
      .prepare('SELECT * FROM dictionary WHERE id = ?')
      .get(id) as unknown as DictionaryRow | undefined;

    const phrase = entry.phrase.trim();
    const replacement =
      entry.replacement !== undefined
        ? entry.replacement
        : existing
          ? existing.replacement
          : null;
    const enabled =
      entry.enabled !== undefined
        ? entry.enabled
          ? 1
          : 0
        : existing
          ? existing.enabled
          : 1;
    const frequencyUsed = entry.frequencyUsed ?? existing?.frequency_used ?? 0;
    const lastUsed =
      entry.lastUsed !== undefined ? entry.lastUsed : (existing?.last_used ?? null);
    const createdAt = existing?.created_at ?? entry.createdAt ?? now;
    const modifiedAt = now;

    this.db
      .prepare(
        `INSERT INTO dictionary (id, phrase, replacement, enabled, frequency_used, last_used, created_at, modified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           phrase = excluded.phrase,
           replacement = excluded.replacement,
           enabled = excluded.enabled,
           frequency_used = excluded.frequency_used,
           last_used = excluded.last_used,
           modified_at = excluded.modified_at`
      )
      .run(id, phrase, replacement, enabled, frequencyUsed, lastUsed, createdAt, modifiedAt);

    const saved = this.db
      .prepare('SELECT * FROM dictionary WHERE id = ?')
      .get(id) as unknown as DictionaryRow;
    return mapDictionaryRow(saved);
  }

  deleteDictionary(id: string): void {
    this.db.prepare('DELETE FROM dictionary WHERE id = ?').run(id);
  }

  incrementDictionaryUsage(ids: string[]): void {
    const uniqueIds = [...new Set(ids.filter(Boolean))];
    if (uniqueIds.length === 0) return;

    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      'UPDATE dictionary SET frequency_used = frequency_used + 1, last_used = ? WHERE id = ?'
    );
    this.runInTransaction(() => {
      for (const id of uniqueIds) {
        stmt.run(now, id);
      }
    });
  }

  listSnippets(): SnippetEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM snippets ORDER BY frequency_used DESC, created_at DESC')
      .all() as unknown as SnippetRow[];
    return rows.map(mapSnippetRow);
  }

  upsertSnippet(
    entry: Partial<SnippetEntry> & { trigger: string; expansion: string }
  ): SnippetEntry {
    const now = new Date().toISOString();
    const id = entry.id?.trim() || crypto.randomUUID();
    const existing = this.db
      .prepare('SELECT * FROM snippets WHERE id = ?')
      .get(id) as unknown as SnippetRow | undefined;

    const trigger = entry.trigger.trim();
    const expansion = entry.expansion;
    const exactOnly =
      entry.exactOnly !== undefined
        ? entry.exactOnly
          ? 1
          : 0
        : existing
          ? existing.exact_only
          : 0;
    const enabled =
      entry.enabled !== undefined
        ? entry.enabled
          ? 1
          : 0
        : existing
          ? existing.enabled
          : 1;
    const frequencyUsed = entry.frequencyUsed ?? existing?.frequency_used ?? 0;
    const lastUsed =
      entry.lastUsed !== undefined ? entry.lastUsed : (existing?.last_used ?? null);
    const createdAt = existing?.created_at ?? entry.createdAt ?? now;
    const modifiedAt = now;

    this.db
      .prepare(
        `INSERT INTO snippets (id, trigger, expansion, exact_only, enabled, frequency_used, last_used, created_at, modified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           trigger = excluded.trigger,
           expansion = excluded.expansion,
           exact_only = excluded.exact_only,
           enabled = excluded.enabled,
           frequency_used = excluded.frequency_used,
           last_used = excluded.last_used,
           modified_at = excluded.modified_at`
      )
      .run(
        id,
        trigger,
        expansion,
        exactOnly,
        enabled,
        frequencyUsed,
        lastUsed,
        createdAt,
        modifiedAt
      );

    const saved = this.db
      .prepare('SELECT * FROM snippets WHERE id = ?')
      .get(id) as unknown as SnippetRow;
    return mapSnippetRow(saved);
  }

  deleteSnippet(id: string): void {
    this.db.prepare('DELETE FROM snippets WHERE id = ?').run(id);
  }

  incrementSnippetUsage(ids: string[]): void {
    const uniqueIds = [...new Set(ids.filter(Boolean))];
    if (uniqueIds.length === 0) return;

    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      'UPDATE snippets SET frequency_used = frequency_used + 1, last_used = ? WHERE id = ?'
    );
    this.runInTransaction(() => {
      for (const id of uniqueIds) {
        stmt.run(now, id);
      }
    });
  }

  listRegexRules(): RegexRuleEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM regex_rules ORDER BY sort_order ASC, created_at ASC')
      .all() as unknown as RegexRuleRow[];
    return rows.map(mapRegexRuleRow);
  }

  upsertRegexRule(
    entry: Partial<RegexRuleEntry> & { name: string; pattern: string }
  ): RegexRuleEntry {
    const now = new Date().toISOString();
    const id = entry.id?.trim() || crypto.randomUUID();
    const existing = this.db
      .prepare('SELECT * FROM regex_rules WHERE id = ?')
      .get(id) as unknown as RegexRuleRow | undefined;

    let sortOrder: number;
    if (entry.sortOrder !== undefined) {
      sortOrder = entry.sortOrder;
    } else if (existing) {
      sortOrder = existing.sort_order;
    } else {
      const maxRow = this.db
        .prepare('SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM regex_rules')
        .get() as { max_order: number };
      sortOrder = maxRow.max_order + 1;
    }

    const name = entry.name.trim();
    const pattern = entry.pattern;
    const flags = entry.flags !== undefined ? entry.flags : (existing?.flags ?? 'giu');
    const replacement =
      entry.replacement !== undefined ? entry.replacement : (existing?.replacement ?? '');
    const enabled =
      entry.enabled !== undefined
        ? entry.enabled
          ? 1
          : 0
        : existing
          ? existing.enabled
          : 1;
    const createdAt = existing?.created_at ?? entry.createdAt ?? now;
    const modifiedAt = now;

    this.db
      .prepare(
        `INSERT INTO regex_rules (id, name, pattern, flags, replacement, enabled, sort_order, created_at, modified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           pattern = excluded.pattern,
           flags = excluded.flags,
           replacement = excluded.replacement,
           enabled = excluded.enabled,
           sort_order = excluded.sort_order,
           modified_at = excluded.modified_at`
      )
      .run(id, name, pattern, flags, replacement, enabled, sortOrder, createdAt, modifiedAt);

    const saved = this.db
      .prepare('SELECT * FROM regex_rules WHERE id = ?')
      .get(id) as unknown as RegexRuleRow;
    return mapRegexRuleRow(saved);
  }

  deleteRegexRule(id: string): void {
    this.db.prepare('DELETE FROM regex_rules WHERE id = ?').run(id);
  }

  reorderRegexRules(orderedIds: string[]): RegexRuleEntry[] {
    const existing = this.listRegexRules();
    const existingIds = new Set(existing.map((r) => r.id));
    const orderedSet = new Set(orderedIds.filter((id) => existingIds.has(id)));
    const finalOrder = [
      ...orderedIds.filter((id) => existingIds.has(id)),
      ...existing.filter((r) => !orderedSet.has(r.id)).map((r) => r.id),
    ];

    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      'UPDATE regex_rules SET sort_order = ?, modified_at = ? WHERE id = ?'
    );

    this.runInTransaction(() => {
      finalOrder.forEach((id, index) => {
        stmt.run(index, now, id);
      });
    });

    return this.listRegexRules();
  }

  listHistory(opts?: {
    search?: string;
    limit?: number;
    includeArchived?: boolean;
  }): HistoryEntry[] {
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (!opts?.includeArchived) {
      conditions.push('archived = 0');
    }

    const search = opts?.search?.trim();
    if (search) {
      const pattern = `%${escapeLike(search)}%`;
      conditions.push(
        `(asr_text LIKE ? ESCAPE '\\' OR formatted_text LIKE ? ESCAPE '\\' OR pasted_text LIKE ? ESCAPE '\\' OR app_name LIKE ? ESCAPE '\\' OR window_title LIKE ? ESCAPE '\\')`
      );
      params.push(pattern, pattern, pattern, pattern, pattern);
    }

    let sql = 'SELECT * FROM history';
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }
    sql += ' ORDER BY timestamp DESC, rowid DESC';

    if (opts?.limit !== undefined && opts.limit > 0) {
      sql += ' LIMIT ?';
      params.push(Math.floor(opts.limit));
    }

    const rows = this.db.prepare(sql).all(...params) as unknown as HistoryRow[];
    return rows.map(mapHistoryRow);
  }

  addHistory(entry: Omit<HistoryEntry, 'id'>): HistoryEntry {
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO history (
          id, timestamp, asr_text, formatted_text, pasted_text,
          app_name, window_title, duration_sec, speech_duration_sec,
          num_words, e2e_latency_ms, language, mic_device, archived
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        entry.timestamp,
        entry.asrText,
        entry.formattedText,
        entry.pastedText,
        entry.appName,
        entry.windowTitle,
        entry.durationSec,
        entry.speechDurationSec,
        entry.numWords,
        entry.e2eLatencyMs,
        entry.language,
        entry.micDevice,
        entry.archived ? 1 : 0
      );

    const saved = this.db
      .prepare('SELECT * FROM history WHERE id = ?')
      .get(id) as unknown as HistoryRow;
    return mapHistoryRow(saved);
  }

  deleteHistory(id: string): void {
    this.db.prepare('DELETE FROM history WHERE id = ?').run(id);
  }

  clearHistory(): void {
    this.db.exec('DELETE FROM history');
  }

  getLatestHistory(): HistoryEntry | null {
    const row = this.db
      .prepare('SELECT * FROM history WHERE archived = 0 ORDER BY timestamp DESC, rowid DESC LIMIT 1')
      .get() as unknown as HistoryRow | undefined;
    return row ? mapHistoryRow(row) : null;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
