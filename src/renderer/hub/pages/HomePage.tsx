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
  const [quickFixPhrase, setQuickFixPhrase] = useState('');
  const [quickFixReplacement, setQuickFixReplacement] = useState('');
  const [quickFixSaving, setQuickFixSaving] = useState(false);
  const [quickFixSavedId, setQuickFixSavedId] = useState<string | null>(null);
  const [quickFixError, setQuickFixError] = useState<string | null>(null);

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
    setQuickFixPhrase('');
    setQuickFixReplacement('');
    setQuickFixError(null);
  };

  const openQuickFix = (entryId: string) => {
    if (quickFixEntryId === entryId) {
      closeQuickFix();
      return;
    }
    const selected = window.getSelection()?.toString().trim() ?? '';
    const prefill = selected && !selected.includes('\n') && selected.length <= 80 ? selected : '';
    setQuickFixEntryId(entryId);
    setQuickFixPhrase(prefill);
    setQuickFixReplacement('');
    setQuickFixError(null);
  };

  const handleQuickFixSubmit = async (e: React.FormEvent, entryId: string) => {
    e.preventDefault();
    const phrase = quickFixPhrase.trim();
    const replacement = quickFixReplacement.trim();
    if (!phrase || !replacement) return;

    setQuickFixSaving(true);
    setQuickFixError(null);
    try {
      const existingList = await window.wisperHub?.listDictionary();
      const existing = existingList?.find(
        (d) => d.phrase.trim().toLowerCase() === phrase.toLowerCase(),
      );
      await window.wisperHub?.upsertDictionary({
        id: existing?.id,
        phrase,
        replacement,
        enabled: true,
      });
      closeQuickFix();
      setQuickFixSavedId(entryId);
      window.setTimeout(() => {
        setQuickFixSavedId((cur) => (cur === entryId ? null : cur));
      }, 2500);
    } catch {
      setQuickFixError('Failed to save rule');
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
            const hasRawDiff =
              entry.asrText.trim().length > 0 &&
              entry.asrText.trim() !== finalText.trim();
            const isExpanded = Boolean(expandedRawIds[entry.id]);

            return (
              <article key={entry.id} className="history-row">
                <div className="history-meta">
                  <div className="history-meta-left">
                    <span>{formatTimestamp(entry.timestamp)}</span>
                    <span className="chip">{entry.appName || 'Active window'}</span>
                    <span>{entry.durationSec.toFixed(1)}s</span>
                    <span>{Math.round(entry.e2eLatencyMs)}ms</span>
                  </div>

                  <div className="history-actions">
                    {quickFixSavedId === entry.id && (
                      <span className="chip success">
                        <Check size={12} />
                        <span>Added to Dictionary</span>
                      </span>
                    )}

                    <button
                      type="button"
                      className="btn btn-sm"
                      title="Turn a misheard word into an auto-correction rule"
                      onClick={() => openQuickFix(entry.id)}
                    >
                      <Pencil size={12} />
                      <span>Fix Word</span>
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
                        <span>Raw ASR</span>
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
                    <strong>Raw ASR:</strong> {entry.asrText}
                  </div>
                )}

                {quickFixEntryId === entry.id && (
                  <form
                    className="quick-fix-row"
                    onSubmit={(e) => void handleQuickFixSubmit(e, entry.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      flexWrap: 'wrap',
                      marginTop: 2,
                      padding: '9px 11px',
                      borderRadius: 8,
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    <input
                      type="text"
                      className="input"
                      style={{ flex: 1, minWidth: 150 }}
                      placeholder="Misheard phrase…"
                      value={quickFixPhrase}
                      onChange={(e) => setQuickFixPhrase(e.target.value)}
                      autoFocus
                    />
                    <input
                      type="text"
                      className="input"
                      style={{ flex: 1, minWidth: 150 }}
                      placeholder="Correct replacement…"
                      value={quickFixReplacement}
                      onChange={(e) => setQuickFixReplacement(e.target.value)}
                    />
                    <button
                      type="submit"
                      className="btn btn-primary btn-sm"
                      disabled={
                        quickFixSaving || !quickFixPhrase.trim() || !quickFixReplacement.trim()
                      }
                    >
                      Add to Dictionary
                    </button>
                    <button type="button" className="btn btn-sm" onClick={closeQuickFix}>
                      Cancel
                    </button>
                    {quickFixError && <span className="chip danger">{quickFixError}</span>}
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
