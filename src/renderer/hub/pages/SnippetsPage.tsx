import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Pencil, Plus, Search, Trash2, X, Zap } from 'lucide-react';
import type { SnippetEntry } from '@shared/types';

export const SnippetsPage: React.FC = () => {
  const [snippets, setSnippets] = useState<SnippetEntry[]>([]);
  const [search, setSearch] = useState('');
  const [trigger, setTrigger] = useState('');
  const [expansion, setExpansion] = useState('');
  const [exactOnly, setExactOnly] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadSnippets = useCallback(async () => {
    try {
      const list = await window.wisperHub?.listSnippets();
      if (Array.isArray(list)) setSnippets(list);
    } catch {}
  }, []);

  useEffect(() => {
    void loadSnippets();
  }, [loadSnippets]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return snippets;
    return snippets.filter(
      (s) => s.trigger.toLowerCase().includes(q) || s.expansion.toLowerCase().includes(q),
    );
  }, [search, snippets]);

  const resetForm = () => {
    setEditingId(null);
    setTrigger('');
    setExpansion('');
    setExactOnly(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanTrigger = trigger.trim();
    if (!cleanTrigger || !expansion) return;

    setSaving(true);
    try {
      const existing = editingId ? snippets.find((s) => s.id === editingId) : undefined;
      await window.wisperHub?.upsertSnippet({
        ...(existing || {}),
        id: editingId ?? undefined,
        trigger: cleanTrigger,
        expansion,
        exactOnly,
        enabled: existing ? existing.enabled : true,
      });
      resetForm();
      await loadSnippets();
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (snippet: SnippetEntry) => {
    setEditingId(snippet.id);
    setTrigger(snippet.trigger);
    setExpansion(snippet.expansion);
    setExactOnly(snippet.exactOnly);
  };

  const handleToggle = async (snippet: SnippetEntry) => {
    setSnippets((prev) =>
      prev.map((s) => (s.id === snippet.id ? { ...s, enabled: !s.enabled } : s)),
    );
    try {
      await window.wisperHub?.upsertSnippet({
        ...snippet,
        enabled: !snippet.enabled,
      });
      await loadSnippets();
    } catch {
      await loadSnippets();
    }
  };

  const handleDelete = async (id: string) => {
    setSnippets((prev) => prev.filter((s) => s.id !== id));
    if (editingId === id) resetForm();
    try {
      await window.wisperHub?.deleteSnippet(id);
    } catch {
      await loadSnippets();
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Snippets</h1>
          <p className="page-subtitle">
            Expand spoken triggers into links, emails, signatures, or multi-line templates.
          </p>
        </div>
      </div>

      <form className="card form-grid" onSubmit={handleSubmit}>
        <div className="toolbar">
          <input
            type="text"
            className="input"
            style={{ flex: 1, minWidth: 200 }}
            placeholder="Spoken trigger (e.g. my calendar link, intro email)…"
            value={trigger}
            onChange={(e) => setTrigger(e.target.value)}
          />
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={exactOnly}
              onChange={(e) => setExactOnly(e.target.checked)}
            />
            <span>Exact utterance only</span>
          </label>
        </div>

        <textarea
          className="textarea"
          placeholder="Expansion text (multi-line supported)…"
          value={expansion}
          onChange={(e) => setExpansion(e.target.value)}
        />

        <div className="toolbar" style={{ justifyContent: 'flex-end' }}>
          {editingId && (
            <button type="button" className="btn" onClick={resetForm}>
              <X size={14} />
              <span>Cancel</span>
            </button>
          )}
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving || !trigger.trim() || !expansion}
          >
            {editingId ? <Check size={14} /> : <Plus size={14} />}
            <span>{editingId ? 'Save Snippet' : 'Add Snippet'}</span>
          </button>
        </div>
      </form>

      <div className="search-box">
        <Search size={15} className="search-icon" />
        <input
          type="search"
          className="input with-icon"
          placeholder="Search snippets…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <Zap size={22} style={{ color: 'var(--text-muted)' }} />
          <h2 className="empty-title">No snippets yet</h2>
          <p className="empty-desc">
            Create voice shortcuts for links, email templates, or boilerplate text. Choose exact
            utterance mode or inline expansion inside longer dictations.
          </p>
        </div>
      ) : (
        <div className="list-stack">
          {filtered.map((snippet) => (
            <div key={snippet.id} className="entry-row">
              <div className="entry-main">
                <div className="entry-title">
                  <span style={{ opacity: snippet.enabled ? 1 : 0.5 }}>{snippet.trigger}</span>
                  <span className="chip">
                    {snippet.exactOnly ? 'Exact utterance' : 'Also inline'}
                  </span>
                </div>
                <div className="entry-sub" style={{ opacity: snippet.enabled ? 1 : 0.5 }}>
                  {snippet.expansion}
                </div>
              </div>

              <div className="entry-controls">
                <span className="chip">{snippet.frequencyUsed} uses</span>
                <label className="switch" title={snippet.enabled ? 'Enabled' : 'Disabled'}>
                  <input
                    type="checkbox"
                    checked={snippet.enabled}
                    onChange={() => void handleToggle(snippet)}
                  />
                  <span className="switch-track" />
                </label>
                <button
                  type="button"
                  className="icon-btn"
                  title="Edit"
                  onClick={() => startEdit(snippet)}
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn danger"
                  title="Delete"
                  onClick={() => void handleDelete(snippet.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
};
