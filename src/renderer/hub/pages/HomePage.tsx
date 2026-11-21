import React, { useCallback, useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  ClipboardPaste,
  Copy,
  Flame,
  Gauge,
  Keyboard,
  Mic,
  Pencil,
  Search,
  Trash2,
  Type,
} from 'lucide-react';
import type { AppSettings, HistoryEntry, OmarchyEnvironment, UsageStats } from '@shared/types';

interface HomePageProps {
  stats: UsageStats;
  settings: AppSettings;
  omarchyEnv: OmarchyEnvironment | null;
  onStatsChanged: () => void;
}

function formatTimeSaved(minutes: number): string {
  if (!minutes || minutes < 1) return '0m';
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded}m`;
  const hrs = Math.floor(rounded / 60);
  const mins = rounded % 60;
  return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const timeStr = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today, ${timeStr}`;
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${timeStr}`;
}

const EDGE_PUNCTUATION_RE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const HAS_ALNUM_RE = /[\p{L}\p{N}]/u;
const MAX_FIX_WORDS = 3;

function tokenizeWords(text: string): string[] {
  const tokens: string[] = [];
  for (const part of text.trim().split(/\s+/)) {
    if (!part) continue;
    const stripped = part.replace(EDGE_PUNCTUATION_RE, '');
    if (stripped && HAS_ALNUM_RE.test(stripped)) tokens.push(stripped);
  }
  return tokens;
}

function extractWordCorrections(
  originalText: string,
  editedText: string,
): Array<{ phrase: string; replacement: string }> {
  const a = tokenizeWords(originalText);
  const b = tokenizeWords(editedText);
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0 || m * n > 2_000_000) return [];

  const stride = n + 1;
  const dp = new Uint16Array((m + 1) * stride);
  for (let i = m - 1; i >= 0; i--) {
    const row = i * stride;
    const nextRow = (i + 1) * stride;
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[row + j] = dp[nextRow + j + 1] + 1;
      } else {
        dp[row + j] = dp[nextRow + j] >= dp[row + j + 1] ? dp[nextRow + j] : dp[row + j + 1];
      }
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[(i + 1) * stride + j] >= dp[i * stride + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  pairs.push([m, n]);

  const diffs: Array<{ phrase: string; replacement: string }> = [];
  let prevA = -1;
  let prevB = -1;
  for (const [curA, curB] of pairs) {
    const aLen = curA - prevA - 1;
    const bLen = curB - prevB - 1;
    if (aLen >= 1 && aLen <= MAX_FIX_WORDS && bLen >= 1 && bLen <= MAX_FIX_WORDS) {
      const phrase = a.slice(prevA + 1, curA).join(' ');
      const replacement = b.slice(prevB + 1, curB).join(' ');
      if (phrase && replacement && phrase !== replacement) {
        diffs.push({ phrase, replacement });
      }
    }
    prevA = curA;
    prevB = curB;
  }
  return diffs;
}

export const HomePage: React.FC<HomePageProps> = ({
  stats,
  settings,
  omarchyEnv,
  onStatsChanged,
}) => {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [expandedRawIds, setExpandedRawIds] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [quickFixEntryId, setQuickFixEntryId] = useState<string | null>(null);
  const [quickFixOriginal, setQuickFixOriginal] = useState('');
  const [quickFixText, setQuickFixText] = useState('');
  const [quickFixSaving, setQuickFixSaving] = useState(false);
  const [quickFixSaved, setQuickFixSaved] = useState<{ id: string; label: string } | null>(null);
  const [quickFixHint, setQuickFixHint] = useState<string | null>(null);

  const loadHistory = useCallback(async (query: string) => {
    try {
      const rows = await window.wisperHub?.listHistory({
        search: query.trim() || undefined,
        limit: 150,
      });
      if (Array.isArray(rows)) setEntries(rows);
    } catch {
      // Ignore transient errors
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadHistory(search);
    }, 100);
    return () => window.clearTimeout(timer);
  }, [loadHistory, search]);

  useEffect(() => {
    const unsub = window.wisperHub?.onHistoryAdded((added) => {
      if (!added) return;
      if (search.trim()) {
        void loadHistory(search);
      } else {
        setEntries((prev) => [added, ...prev.filter((e) => e.id !== added.id)]);
      }
    });
    return () => unsub?.();
  }, [loadHistory, search]);

  const handleCopy = async (id: string) => {
    try {
      await window.wisperHub?.copyHistoryEntry(id);
      setCopiedId(id);
      window.setTimeout(() => {
        setCopiedId((cur) => (cur === id ? null : cur));
      }, 1500);
    } catch {}
  };

  const handleRepaste = async (id: string) => {
    try {
      await window.wisperHub?.pasteHistoryEntry(id);
    } catch {}
  };

  const handleDelete = async (id: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
    try {
      await window.wisperHub?.deleteHistory(id);
      onStatsChanged();
    } catch {
      void loadHistory(search);
    }
  };

  const handleClearAll = async () => {
    setEntries([]);
    setConfirmClear(false);
    try {
      await window.wisperHub?.clearHistory();
      onStatsChanged();
    } catch {
      void loadHistory(search);
    }
  };

  const closeQuickFix = () => {
    setQuickFixEntryId(null);
    setQuickFixOriginal('');
    setQuickFixText('');
    setQuickFixHint(null);
  };

  const openQuickFix = (entry: HistoryEntry) => {
    if (quickFixEntryId === entry.id) {
      closeQuickFix();
      return;
    }
    const baseText = entry.pastedText || entry.formattedText || entry.asrText;
    setQuickFixEntryId(entry.id);
    setQuickFixOriginal(baseText);
    setQuickFixText(baseText);
    setQuickFixHint(null);
  };

  const handleQuickFixSubmit = async (e: React.FormEvent, entryId: string) => {
    e.preventDefault();
    const diffs = extractWordCorrections(quickFixOriginal, quickFixText);
    if (diffs.length === 0) {
      setQuickFixHint('Edit 1–3 words in the text above to save a dictionary rule.');
      return;
    }

    setQuickFixSaving(true);
    setQuickFixHint(null);
    try {
      const existingList = await window.wisperHub?.listDictionary();
      for (const diff of diffs) {
        const existing = existingList?.find(
          (d) => d.phrase.trim().toLowerCase() === diff.phrase.toLowerCase(),
        );
        await window.wisperHub?.upsertDictionary({
          id: existing?.id,
          phrase: diff.phrase,
          replacement: diff.replacement,
          enabled: true,
        });
      }
      const cleanedCorrected = quickFixText.trim();
      if (cleanedCorrected) {
        await window.wisperHub?.setHistoryCorrectedText(entryId, cleanedCorrected);
      }
      const first = diffs[0];
      const label =
        diffs.length === 1
          ? `Saved: "${first.phrase}" → "${first.replacement}"`
          : `Saved ${diffs.length} rules ("${first.phrase}" → "${first.replacement}")`;
      closeQuickFix();
      setQuickFixSaved({ id: entryId, label });
      window.setTimeout(() => {
        setQuickFixSaved((cur) => (cur?.id === entryId ? null : cur));
      }, 3500);
    } catch {
      setQuickFixHint('Failed to save rule to dictionary.');
    } finally {
      setQuickFixSaving(false);
    }
  };

  const isLinux = omarchyEnv?.isLinux ?? false;
  const pttHint = settings.shortcuts.pushToTalk || (isLinux ? 'RightAlt' : 'Ctrl+Win');

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Home</h1>
          <p className="page-subtitle">
            Dictate anywhere with <span className="kbd">{pttHint}</span> or lock hands-free with{' '}
            <span className="kbd">{settings.shortcuts.handsFree}</span>
          </p>
        </div>
      </div>

      <section className="stats-grid" aria-label="Dictation statistics">
        <div className="stat-card">
          <div className="stat-label">
            <span>Total Words</span>
            <Type size={14} />
          </div>
          <div className="stat-value">{stats.totalWords.toLocaleString()}</div>
          <div className="stat-meta">{stats.todayWords.toLocaleString()} today</div>
        </div>

        <div className="stat-card">
          <div className="stat-label">
            <span>Average WPM</span>
            <Gauge size={14} />
          </div>
          <div className="stat-value">{Math.round(stats.averageWpm || 0)}</div>
          <div className="stat-meta">{stats.totalDictations} dictations</div>
        </div>

        <div className="stat-card">
          <div className="stat-label">
            <span>Daily Streak</span>
            <Flame size={14} />
          </div>
          <div className="stat-value">
            {stats.streakDays} {stats.streakDays === 1 ? 'day' : 'days'}
          </div>
          <div className="stat-meta">Active dictation days</div>
        </div>

        <div className="stat-card">
          <div className="stat-label">
            <span>Time Saved</span>
            <Clock size={14} />
          </div>
          <div className="stat-value">{formatTimeSaved(stats.timeSavedMinutes)}</div>
          <div className="stat-meta">vs. 40 WPM typing</div>
        </div>
      </section>

      <div className="toolbar">
        <div className="search-box">
          <Search size={15} className="search-icon" />
          <input
            type="search"
            className="input with-icon"
            placeholder="Search transcripts or apps…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {entries.length > 0 &&
          (confirmClear ? (
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" className="btn btn-danger btn-sm" onClick={handleClearAll}>
                Confirm clear
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setConfirmClear(false)}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setConfirmClear(true)}
            >
              <Trash2 size={13} />
              <span>Clear history</span>
            </button>
          ))}
      </div>

      {loading ? (
        <div className="card" style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          Loading dictation history…
        </div>
      ) : entries.length === 0 ? (
        <div className="empty-state">
          <Mic size={22} style={{ color: 'var(--text-muted)' }} />
          <h2 className="empty-title">
            {search.trim() ? 'No matching dictations' : 'Ready to dictate'}
          </h2>
          <p className="empty-desc">
            {search.trim() ? (
              'Try a different search term or clear your filter.'
            ) : (
              <>
                Hold <span className="kbd">{pttHint}</span>{' '}
                {isLinux ? 'on Omarchy' : 'on Windows'} to speak and release to paste. You can also
                click the Flow Bar pill at the edge of your screen.
              </>
            )}
          </p>
        </div>
      ) : (
        <div className="list-stack">
          {entries.map((entry) => {
            const finalText = entry.pastedText || entry.formattedText || entry.asrText;
            const isTypoFix = entry.mode === 'typo-fix';
            const hasRawDiff =
              entry.asrText.trim().length > 0 &&
              entry.asrText.trim() !== finalText.trim();
            const isExpanded = Boolean(expandedRawIds[entry.id]);

            return (
              <article key={entry.id} className="history-row">
                <div className="history-meta">
                  <div className="history-meta-left">
                    <span>{formatTimestamp(entry.timestamp)}</span>
                    {isTypoFix && (
                      <span
                        className="chip accent"
                        title={`Keyboard typo fix (${settings.shortcuts.fixInputHotkey || 'Alt+F'})`}
                      >
                        <Keyboard size={12} />
                        <span>Typo Fix</span>
                      </span>
                    )}
                    <span className="chip">{entry.appName || 'Active window'}</span>
                    {!isTypoFix && <span>{entry.durationSec.toFixed(1)}s</span>}
                    <span>
                      {isTypoFix && entry.e2eLatencyMs < 1
                        ? '<1ms'
                        : `${Math.round(entry.e2eLatencyMs)}ms`}
                    </span>
                  </div>

                  <div className="history-actions">
                    {quickFixSaved?.id === entry.id && (
                      <span className="chip success">
                        <Check size={12} />
                        <span>{quickFixSaved.label}</span>
                      </span>
                    )}

                    <button
                      type="button"
                      className="btn btn-sm"
                      title="Edit 1–3 words to teach Wisper Flow a dictionary correction"
                      onClick={() => openQuickFix(entry)}
                    >
                      <Pencil size={12} />
                      <span>Fix &amp; Teach</span>
                    </button>

                    {hasRawDiff && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() =>
                          setExpandedRawIds((prev) => ({
                            ...prev,
                            [entry.id]: !prev[entry.id],
                          }))
                        }
                      >
                        <span>{isTypoFix ? 'Original' : 'Raw ASR'}</span>
                        {isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                      </button>
                    )}

                    <button
                      type="button"
                      className="icon-btn"
                      title="Copy text"
                      aria-label="Copy text"
                      onClick={() => void handleCopy(entry.id)}
                    >
                      {copiedId === entry.id ? <Check size={14} /> : <Copy size={14} />}
                    </button>

                    <button
                      type="button"
                      className="icon-btn"
                      title="Re-paste to last window"
                      aria-label="Re-paste to last window"
                      onClick={() => void handleRepaste(entry.id)}
                    >
                      <ClipboardPaste size={14} />
                    </button>

                    <button
                      type="button"
                      className="icon-btn danger"
                      title="Delete entry"
                      aria-label="Delete entry"
                      onClick={() => void handleDelete(entry.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                <p className="history-text">{finalText}</p>

                {hasRawDiff && isExpanded && (
                  <div className="raw-diff-box">
                    <strong>{isTypoFix ? 'Original typed:' : 'Raw ASR:'}</strong> {entry.asrText}
                  </div>
                )}

                {quickFixEntryId === entry.id && (
                  <form
                    className="fix-teach-box"
                    onSubmit={(e) => void handleQuickFixSubmit(e, entry.id)}
                  >
                    <input
                      type="text"
                      className="input"
                      value={quickFixText}
                      onChange={(e) => {
                        setQuickFixText(e.target.value);
                        if (quickFixHint) setQuickFixHint(null);
                      }}
                      placeholder="Edit 1–3 misheard words…"
                      autoFocus
                    />
                    <div className="fix-teach-actions">
                      <button
                        type="submit"
                        className="btn btn-primary btn-sm"
                        disabled={quickFixSaving || !quickFixText.trim()}
                      >
                        Save to Dictionary
                      </button>
                      <button type="button" className="btn btn-sm" onClick={closeQuickFix}>
                        Cancel
                      </button>
                      {quickFixHint && <span className="chip warning">{quickFixHint}</span>}
                    </div>
                  </form>
                )}
              </article>
            );
          })}
        </div>
      )}
    </>
  );
};
