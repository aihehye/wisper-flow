import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  Check,
  Download,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { DictionaryEntry, DictionarySuggestion } from '@shared/types';

type DictionaryTab = 'hints' | 'replacements';

interface DictionaryStarterPack {
  id: string;
  label: string;
  items: ReadonlyArray<{ phrase: string; replacement: string }>;
}

const STARTER_PACKS: readonly DictionaryStarterPack[] = [
  {
    id: 'tech-acronyms',
    label: 'Tech Acronyms',
    items: [
      { phrase: 'api', replacement: 'API' },
      { phrase: 'gpu', replacement: 'GPU' },
      { phrase: 'cpu', replacement: 'CPU' },
      { phrase: 'sql', replacement: 'SQL' },
      { phrase: 'json', replacement: 'JSON' },
      { phrase: 'ui', replacement: 'UI' },
      { phrase: 'ux', replacement: 'UX' },
      { phrase: 'llm', replacement: 'LLM' },
      { phrase: 'cli', replacement: 'CLI' },
      { phrase: 'html', replacement: 'HTML' },
      { phrase: 'css', replacement: 'CSS' },
      { phrase: 'ssh', replacement: 'SSH' },
    ],
  },
  {
    id: 'stt-dev-fixes',
    label: 'STT & Dev Fixes',
    items: [
      { phrase: 'whisper flow', replacement: 'Wispr Flow' },
      { phrase: 'whisper flower', replacement: 'Wispr Flow' },
      { phrase: 'wipser flow', replacement: 'Wispr Flow' },
      { phrase: 'OMRG', replacement: 'Omarchy' },
      { phrase: 'once a patient', replacement: 'subagent' },
      { phrase: 'subageagent', replacement: 'subagent' },
      { phrase: 'hyperland', replacement: 'Hyprland' },
      { phrase: 'control windows', replacement: 'Ctrl+Win' },
    ],
  },
];

export const DictionaryPage: React.FC = () => {
  const [entries, setEntries] = useState<DictionaryEntry[]>([]);
  const [suggestions, setSuggestions] = useState<DictionarySuggestion[]>([]);
  const [busySuggestionId, setBusySuggestionId] = useState<string | null>(null);
  const [tab, setTab] = useState<DictionaryTab>('hints');
  const [search, setSearch] = useState('');
  const [phraseInput, setPhraseInput] = useState('');
  const [replacementInput, setReplacementInput] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPhrase, setEditPhrase] = useState('');
  const [editReplacement, setEditReplacement] = useState('');
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ text: string; kind: 'success' | 'danger' } | null>(
    null,
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const showStatus = useCallback((text: string, kind: 'success' | 'danger' = 'success') => {
    setStatusMsg({ text, kind });
  }, []);

  useEffect(() => {
    if (!statusMsg) return;
    const timer = window.setTimeout(() => setStatusMsg(null), 4000);
    return () => window.clearTimeout(timer);
  }, [statusMsg]);

  const loadEntries = useCallback(async () => {
    try {
      const list = await window.wisperHub?.listDictionary();
      if (Array.isArray(list)) setEntries(list);
    } catch {}
  }, []);

  const loadSuggestions = useCallback(async () => {
    try {
      const list = await window.wisperHub?.listDictionarySuggestions();
      if (Array.isArray(list)) setSuggestions(list);
    } catch {}
  }, []);

  useEffect(() => {
    void loadEntries();
    void loadSuggestions();
    const unsub = window.wisperHub?.onSuggestionsUpdated(() => {
      void loadSuggestions();
    });
    return () => unsub?.();
  }, [loadEntries, loadSuggestions]);

  const handleAcceptSuggestion = async (suggestion: DictionarySuggestion) => {
    setBusySuggestionId(suggestion.id);
    setSuggestions((prev) => prev.filter((item) => item.id !== suggestion.id));
    try {
      await window.wisperHub?.acceptDictionarySuggestion(suggestion.id);
      await loadEntries();
      showStatus(`Added "${suggestion.phrase}" → "${suggestion.replacement}".`);
    } catch {
      await loadSuggestions();
      showStatus('Failed to add suggestion.', 'danger');
    } finally {
      setBusySuggestionId(null);
    }
  };

  const handleDismissSuggestion = async (suggestionId: string) => {
    setBusySuggestionId(suggestionId);
    setSuggestions((prev) => prev.filter((item) => item.id !== suggestionId));
    try {
      await window.wisperHub?.dismissDictionarySuggestion(suggestionId);
    } catch {
      await loadSuggestions();
    } finally {
      setBusySuggestionId(null);
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((item) => {
      const isHint = item.replacement === null;
      if (tab === 'hints' && !isHint) return false;
      if (tab === 'replacements' && isHint) return false;
      if (!q) return true;
      return (
        item.phrase.toLowerCase().includes(q) ||
        (item.replacement || '').toLowerCase().includes(q)
      );
    });
  }, [entries, search, tab]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const phrase = phraseInput.trim();
    if (!phrase) return;
    const replacement = tab === 'hints' ? null : replacementInput.trim();
    if (tab === 'replacements' && !replacement) return;

    setSaving(true);
    try {
      await window.wisperHub?.upsertDictionary({
        phrase,
        replacement,
        enabled: true,
      });
      setPhraseInput('');
      setReplacementInput('');
      await loadEntries();
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (entry: DictionaryEntry) => {
    setEntries((prev) =>
      prev.map((item) => (item.id === entry.id ? { ...item, enabled: !item.enabled } : item)),
    );
    try {
      await window.wisperHub?.upsertDictionary({
        ...entry,
        enabled: !entry.enabled,
      });
      await loadEntries();
    } catch {
      await loadEntries();
    }
  };

  const startEdit = (entry: DictionaryEntry) => {
    setEditingId(entry.id);
    setEditPhrase(entry.phrase);
    setEditReplacement(entry.replacement ?? '');
  };

  const saveEdit = async (entry: DictionaryEntry) => {
    const phrase = editPhrase.trim();
    if (!phrase) return;
    const replacement = entry.replacement === null ? null : editReplacement.trim();
    if (entry.replacement !== null && !replacement) return;

    try {
      await window.wisperHub?.upsertDictionary({
        ...entry,
        phrase,
        replacement,
      });
      setEditingId(null);
      await loadEntries();
    } catch {}
  };

  const handleDelete = async (id: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
    try {
      await window.wisperHub?.deleteDictionary(id);
    } catch {
      await loadEntries();
    }
  };

  const existingPhraseSet = useMemo(
    () => new Set(entries.map((e) => e.phrase.trim().toLowerCase())),
    [entries],
  );

  const handleApplyStarterPack = async (pack: DictionaryStarterPack) => {
    const missing = pack.items.filter(
      (item) => !existingPhraseSet.has(item.phrase.trim().toLowerCase()),
    );
    if (missing.length === 0) {
      showStatus(`All ${pack.label} entries are already in your dictionary.`);
      return;
    }

    setSaving(true);
    try {
      for (const item of missing) {
        await window.wisperHub?.upsertDictionary({
          phrase: item.phrase,
          replacement: item.replacement,
          enabled: true,
        });
      }
      setTab('replacements');
      await loadEntries();
      showStatus(`Added ${missing.length} ${pack.label} entries.`);
    } catch {
      showStatus(`Failed to add ${pack.label} entries.`, 'danger');
    } finally {
      setSaving(false);
    }
  };

  const handleExportJson = () => {
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      dictionary: entries.map((e) => ({
        phrase: e.phrase,
        replacement: e.replacement,
        enabled: e.enabled,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'wisper-flow-dictionary.json';
    link.click();
    URL.revokeObjectURL(url);
    showStatus(`Exported ${entries.length} dictionary entries.`);
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    try {
      const text = await file.text();
      const parsed: unknown = JSON.parse(text);
      const rawItems = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object'
          ? ((parsed as { dictionary?: unknown; entries?: unknown }).dictionary ??
            (parsed as { entries?: unknown }).entries)
          : null;

      if (!Array.isArray(rawItems)) {
        showStatus('Invalid dictionary JSON format.', 'danger');
        return;
      }

      const seen = new Set(existingPhraseSet);
      const toImport: Array<{ phrase: string; replacement: string | null; enabled: boolean }> = [];
      let skipped = 0;

      for (const raw of rawItems) {
        if (!raw || typeof raw !== 'object') continue;
        const record = raw as Record<string, unknown>;
        const phrase = typeof record.phrase === 'string' ? record.phrase.trim() : '';
        if (!phrase) continue;

        const key = phrase.toLowerCase();
        if (seen.has(key)) {
          skipped += 1;
          continue;
        }
        seen.add(key);

        const replacement =
          record.replacement === null || record.replacement === undefined
            ? null
            : typeof record.replacement === 'string'
              ? record.replacement.trim() || null
              : null;
        const enabled = typeof record.enabled === 'boolean' ? record.enabled : true;

        toImport.push({ phrase, replacement, enabled });
      }

      if (toImport.length === 0) {
        showStatus(
          skipped > 0
            ? `No new entries imported (${skipped} existing skipped).`
            : 'No valid dictionary entries found in file.',
          skipped > 0 ? 'success' : 'danger',
        );
        return;
      }

      setSaving(true);
      try {
        for (const item of toImport) {
          await window.wisperHub?.upsertDictionary(item);
        }
        await loadEntries();
        showStatus(
          skipped > 0
            ? `Imported ${toImport.length} entries (${skipped} existing skipped).`
            : `Imported ${toImport.length} dictionary entries.`,
        );
      } finally {
        setSaving(false);
      }
    } catch {
      showStatus('Failed to parse dictionary JSON file.', 'danger');
    }
  };

  const hintCount = entries.filter((e) => e.replacement === null).length;
  const replacementCount = entries.filter((e) => e.replacement !== null).length;

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Dictionary</h1>
          <p className="page-subtitle">
            Teach Rumble-2-Flash custom names, jargon, and exact phrase corrections.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div className="io-actions" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={handleExportJson}
              disabled={entries.length === 0}
              title="Export dictionary entries as JSON"
            >
              <Download size={13} />
              <span>Export JSON</span>
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={saving}
              title="Import dictionary entries from JSON"
            >
              <Upload size={13} />
              <span>Import JSON</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              style={{ display: 'none' }}
              onChange={(e) => void handleImportFile(e)}
            />
          </div>

          <div className="tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'hints'}
              className={`tab-btn ${tab === 'hints' ? 'active' : ''}`}
              onClick={() => {
                setTab('hints');
                setEditingId(null);
              }}
            >
              Vocabulary Hints ({hintCount})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'replacements'}
              className={`tab-btn ${tab === 'replacements' ? 'active' : ''}`}
              onClick={() => {
                setTab('replacements');
                setEditingId(null);
              }}
            >
              Auto-Replacements ({replacementCount})
            </button>
          </div>
        </div>
      </div>

      {suggestions.length > 0 && (
        <section className="card suggestions-card" aria-label="Suggested from your recent edits">
          <div className="suggestions-header">
            <span className="suggestions-title">
              <Sparkles size={14} style={{ color: 'var(--accent)' }} />
              <span>Suggested from your recent edits</span>
            </span>
            <span className="chip accent">{suggestions.length}</span>
          </div>
          <div className="suggestions-list">
            {suggestions.map((suggestion) => {
              const isBusy = busySuggestionId === suggestion.id;
              return (
                <div key={suggestion.id} className="suggestion-row">
                  <div className="suggestion-main">
                    <span className="suggestion-phrase">&ldquo;{suggestion.phrase}&rdquo;</span>
                    <ArrowRight size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                    <span className="suggestion-replacement">
                      &ldquo;{suggestion.replacement}&rdquo;
                    </span>
                    {suggestion.appName && <span className="chip">{suggestion.appName}</span>}
                  </div>
                  <div className="suggestion-actions">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={isBusy}
                      onClick={() => void handleAcceptSuggestion(suggestion)}
                    >
                      <Check size={13} />
                      <span>Add</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={isBusy}
                      onClick={() => void handleDismissSuggestion(suggestion.id)}
                    >
                      <X size={13} />
                      <span>Dismiss</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <div
        className="card preset-bar"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          flexWrap: 'wrap',
          padding: '11px 14px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 12.5,
              fontWeight: 600,
              color: 'var(--text-muted)',
            }}
          >
            <Sparkles size={13} />
            <span>Starter Packs:</span>
          </span>
          {STARTER_PACKS.map((pack) => {
            const missingCount = pack.items.filter(
              (item) => !existingPhraseSet.has(item.phrase.trim().toLowerCase()),
            ).length;
            const allAdded = missingCount === 0;
            return (
              <button
                key={pack.id}
                type="button"
                className="btn btn-sm preset-chip"
                style={{ borderRadius: 999 }}
                disabled={saving || allAdded}
                onClick={() => void handleApplyStarterPack(pack)}
                title={pack.items.map((i) => `${i.phrase} → ${i.replacement}`).join(', ')}
              >
                {allAdded ? <Check size={12} /> : <Plus size={12} />}
                <span>
                  {pack.label} {allAdded ? '(Added)' : `(+${missingCount})`}
                </span>
              </button>
            );
          })}
        </div>

        {statusMsg && (
          <span className={`chip ${statusMsg.kind === 'danger' ? 'danger' : 'success'}`}>
            {statusMsg.text}
          </span>
        )}
      </div>

      <form className="card toolbar" onSubmit={handleAdd}>
        <input
          type="text"
          className="input"
          style={{ flex: 1, minWidth: 180 }}
          placeholder={
            tab === 'hints' ? 'Add term (e.g. Omarchy, Hyprland, Maniteja)…' : 'Spoken phrase…'
          }
          value={phraseInput}
          onChange={(e) => setPhraseInput(e.target.value)}
        />
        {tab === 'replacements' && (
          <input
            type="text"
            className="input"
            style={{ flex: 1, minWidth: 180 }}
            placeholder="Replace with…"
            value={replacementInput}
            onChange={(e) => setReplacementInput(e.target.value)}
          />
        )}
        <button
          type="submit"
          className="btn btn-primary"
          disabled={
            saving || !phraseInput.trim() || (tab === 'replacements' && !replacementInput.trim())
          }
        >
          <Plus size={15} />
          <span>{tab === 'hints' ? 'Add Hint' : 'Add Replacement'}</span>
        </button>
      </form>

      <div className="search-box">
        <Search size={15} className="search-icon" />
        <input
          type="search"
          className="input with-icon"
          placeholder="Filter entries…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <BookOpen size={22} style={{ color: 'var(--text-muted)' }} />
          <h2 className="empty-title">
            {tab === 'hints' ? 'No vocabulary hints yet' : 'No auto-replacements yet'}
          </h2>
          <p className="empty-desc">
            {tab === 'hints'
              ? 'Vocabulary hints bias Rumble-2-Flash toward proper nouns, acronyms, and project names.'
              : 'Auto-replacements deterministically rewrite misheard words or spoken aliases after transcription.'}
          </p>
        </div>
      ) : (
        <div className="list-stack">
          {filtered.map((entry) => {
            const isEditing = editingId === entry.id;
            return (
              <div key={entry.id} className="entry-row">
                {isEditing ? (
                  <div className="toolbar" style={{ flex: 1 }}>
                    <input
                      type="text"
                      className="input"
                      style={{ flex: 1, minWidth: 160 }}
                      value={editPhrase}
                      onChange={(e) => setEditPhrase(e.target.value)}
                    />
                    {entry.replacement !== null && (
                      <input
                        type="text"
                        className="input"
                        style={{ flex: 1, minWidth: 160 }}
                        value={editReplacement}
                        onChange={(e) => setEditReplacement(e.target.value)}
                      />
                    )}
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => void saveEdit(entry)}
                    >
                      <Check size={13} />
                      <span>Save</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setEditingId(null)}
                    >
                      <X size={13} />
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="entry-main">
                      <div className="entry-title">
                        <span style={{ opacity: entry.enabled ? 1 : 0.5 }}>{entry.phrase}</span>
                        {entry.replacement !== null && (
                          <>
                            <ArrowRight size={13} style={{ color: 'var(--text-muted)' }} />
                            <span style={{ opacity: entry.enabled ? 1 : 0.5 }}>
                              {entry.replacement}
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="entry-controls">
                      <span className="chip">{entry.frequencyUsed} uses</span>
                      <label className="switch" title={entry.enabled ? 'Enabled' : 'Disabled'}>
                        <input
                          type="checkbox"
                          checked={entry.enabled}
                          onChange={() => void handleToggle(entry)}
                        />
                        <span className="switch-track" />
                      </label>
                      <button
                        type="button"
                        className="icon-btn"
                        title="Edit"
                        onClick={() => startEdit(entry)}
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn danger"
                        title="Delete"
                        onClick={() => void handleDelete(entry.id)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
};
