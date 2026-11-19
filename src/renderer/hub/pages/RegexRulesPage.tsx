import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  Download,
  Pencil,
  Play,
  Plus,
  Regex,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { PipelineTrace, RegexRuleEntry } from '@shared/types';

const AVAILABLE_FLAGS = ['g', 'i', 'm', 'u'] as const;

interface RegexPreset {
  id: string;
  name: string;
  pattern: string;
  flags: string;
  replacement: string;
}

const REGEX_PRESETS: readonly RegexPreset[] = [
  {
    id: 'collapse-spoken-stutters',
    name: 'Collapse spoken stutters',
    pattern: String.raw`\b([A-Za-z]+(?:\s+[A-Za-z]+)?)\s+\1\b`,
    flags: 'gi',
    replacement: '$1',
  },
  {
    id: 'spoken-domains',
    name: 'Spoken domains (dot com/io/dev)',
    pattern: String.raw`\b([a-z0-9-]+)\s+dot\s+(com|org|io|dev|ai|net)\b`,
    flags: 'gi',
    replacement: '$1.$2',
  },
  {
    id: 'clean-space-punctuation',
    name: 'Clean space before punctuation',
    pattern: String.raw`\s+([,.!?;:])`,
    flags: 'g',
    replacement: '$1',
  },
  {
    id: 'trim-trailing-period',
    name: 'Trim trailing period on short chat',
    pattern: String.raw`^([^.!?]{1,45})\.$`,
    flags: '',
    replacement: '$1',
  },
];

function validateRegex(pattern: string, flags: string): string | null {
  if (!pattern) return 'Pattern is required';
  try {
    new RegExp(pattern, flags);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid regular expression';
  }
}

export const RegexRulesPage: React.FC = () => {
  const [rules, setRules] = useState<RegexRuleEntry[]>([]);
  const [name, setName] = useState('');
  const [pattern, setPattern] = useState('');
  const [flags, setFlags] = useState('gi');
  const [replacement, setReplacement] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [sampleInput, setSampleInput] = useState(
    'hey team um check my calendar link for the meeting',
  );
  const [sampleApp, setSampleApp] = useState('');
  const [trace, setTrace] = useState<PipelineTrace | null>(null);
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

  const loadRules = useCallback(async () => {
    try {
      const list = await window.wisperHub?.listRegexRules();
      if (Array.isArray(list)) {
        setRules([...list].sort((a, b) => a.sortOrder - b.sortOrder));
      }
    } catch {}
  }, []);

  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  const runPipelineTest = useCallback(async (input: string, app: string) => {
    try {
      const res = await window.wisperHub?.testPipeline(input, app.trim() || undefined);
      if (res) setTrace(res);
    } catch {}
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void runPipelineTest(sampleInput, sampleApp);
    }, 140);
    return () => window.clearTimeout(timer);
  }, [rules, runPipelineTest, sampleApp, sampleInput]);

  const patternError = useMemo(() => {
    if (!pattern) return null;
    return validateRegex(pattern, flags);
  }, [flags, pattern]);

  const toggleFlag = (flag: string) => {
    setFlags((prev) => {
      const next = new Set(prev.split(''));
      if (next.has(flag)) next.delete(flag);
      else next.add(flag);
      return AVAILABLE_FLAGS.filter((f) => next.has(f)).join('');
    });
  };

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setPattern('');
    setFlags('gi');
    setReplacement('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !pattern || patternError) return;
    setSaving(true);
    try {
      const existing = editingId ? rules.find((r) => r.id === editingId) : undefined;
      await window.wisperHub?.upsertRegexRule({
        ...(existing || {}),
        id: editingId ?? undefined,
        name: name.trim(),
        pattern,
        flags,
        replacement,
        enabled: existing ? existing.enabled : true,
        sortOrder: existing ? existing.sortOrder : rules.length,
      });
      resetForm();
      await loadRules();
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (rule: RegexRuleEntry) => {
    setEditingId(rule.id);
    setName(rule.name);
    setPattern(rule.pattern);
    setFlags(rule.flags);
    setReplacement(rule.replacement);
  };

  const handleToggle = async (rule: RegexRuleEntry) => {
    setRules((prev) =>
      prev.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r)),
    );
    try {
      await window.wisperHub?.upsertRegexRule({ ...rule, enabled: !rule.enabled });
      await loadRules();
    } catch {
      await loadRules();
    }
  };

  const handleDelete = async (id: string) => {
    setRules((prev) => prev.filter((r) => r.id !== id));
    if (editingId === id) resetForm();
    try {
      await window.wisperHub?.deleteRegexRule(id);
    } catch {
      await loadRules();
    }
  };

  const handleMove = async (index: number, direction: -1 | 1) => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= rules.length) return;
    const reordered = [...rules];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(targetIndex, 0, moved);
    setRules(reordered);
    try {
      const updated = await window.wisperHub?.reorderRegexRules(reordered.map((r) => r.id));
      if (Array.isArray(updated)) {
        setRules([...updated].sort((a, b) => a.sortOrder - b.sortOrder));
      }
    } catch {
      await loadRules();
    }
  };

  const isPresetAdded = useCallback(
    (preset: RegexPreset) =>
      rules.some((r) => r.pattern === preset.pattern && r.flags === preset.flags),
    [rules],
  );

  const handleApplyPreset = async (preset: RegexPreset) => {
    if (isPresetAdded(preset)) {
      showStatus(`"${preset.name}" is already added.`);
      return;
    }

    setSaving(true);
    try {
      await window.wisperHub?.upsertRegexRule({
        name: preset.name,
        pattern: preset.pattern,
        flags: preset.flags,
        replacement: preset.replacement,
        enabled: true,
        sortOrder: rules.length,
      });
      await loadRules();
      showStatus(`Added "${preset.name}".`);
    } catch {
      showStatus(`Failed to add "${preset.name}".`, 'danger');
    } finally {
      setSaving(false);
    }
  };

  const handleExportJson = () => {
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      regexRules: rules.map((r) => ({
        name: r.name,
        pattern: r.pattern,
        flags: r.flags,
        replacement: r.replacement,
        enabled: r.enabled,
        sortOrder: r.sortOrder,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'wisper-flow-regex-rules.json';
    link.click();
    URL.revokeObjectURL(url);
    showStatus(`Exported ${rules.length} regex rules.`);
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
          ? ((parsed as { regexRules?: unknown; rules?: unknown }).regexRules ??
            (parsed as { rules?: unknown }).rules)
          : null;

      if (!Array.isArray(rawItems)) {
        showStatus('Invalid regex rules JSON format.', 'danger');
        return;
      }

      const existingKeys = new Set(rules.map((r) => `${r.pattern}\u0000${r.flags}`));
      const toImport: Array<{
        name: string;
        pattern: string;
        flags: string;
        replacement: string;
        enabled: boolean;
        sortOrder: number;
      }> = [];
      let skipped = 0;

      for (const raw of rawItems) {
        if (!raw || typeof raw !== 'object') continue;
        const record = raw as Record<string, unknown>;
        const ruleName = typeof record.name === 'string' ? record.name.trim() : '';
        const rulePattern = typeof record.pattern === 'string' ? record.pattern : '';
        if (!ruleName || !rulePattern) continue;

        const rawFlags = typeof record.flags === 'string' ? record.flags : 'gi';
        const sanitizedFlags = AVAILABLE_FLAGS.filter((f) => rawFlags.includes(f)).join('');
        if (validateRegex(rulePattern, sanitizedFlags)) {
          skipped += 1;
          continue;
        }

        const key = `${rulePattern}\u0000${sanitizedFlags}`;
        if (existingKeys.has(key)) {
          skipped += 1;
          continue;
        }
        existingKeys.add(key);

        const ruleReplacement =
          typeof record.replacement === 'string' ? record.replacement : '';
        const enabled = typeof record.enabled === 'boolean' ? record.enabled : true;
        const sortOrder =
          typeof record.sortOrder === 'number' && Number.isFinite(record.sortOrder)
            ? record.sortOrder
            : rules.length + toImport.length;

        toImport.push({
          name: ruleName,
          pattern: rulePattern,
          flags: sanitizedFlags,
          replacement: ruleReplacement,
          enabled,
          sortOrder,
        });
      }

      if (toImport.length === 0) {
        showStatus(
          skipped > 0
            ? `No new rules imported (${skipped} existing or invalid skipped).`
            : 'No valid regex rules found in file.',
          skipped > 0 ? 'success' : 'danger',
        );
        return;
      }

      setSaving(true);
      try {
        for (const item of toImport) {
          await window.wisperHub?.upsertRegexRule(item);
        }
        await loadRules();
        showStatus(
          skipped > 0
            ? `Imported ${toImport.length} regex rules (${skipped} skipped).`
            : `Imported ${toImport.length} regex rules.`,
        );
      } finally {
        setSaving(false);
      }
    } catch {
      showStatus('Failed to parse regex rules JSON file.', 'danger');
    }
  };

  const stages = trace
    ? [
        { label: '1. Raw Input', value: trace.input, prev: trace.input },
        { label: '2. Prefix Strip', value: trace.afterPrefixStrip, prev: trace.input },
        {
          label: '3. Exact Snippet',
          value: trace.afterExactSnippet,
          prev: trace.afterPrefixStrip,
        },
        {
          label: '4. Dictionary & Inline',
          value: trace.afterDictionaryAndInlineSnippets,
          prev: trace.afterExactSnippet,
        },
        {
          label: '5. Regex Rules',
          value: trace.afterRegexRules,
          prev: trace.afterDictionaryAndInlineSnippets,
        },
        {
          label: '6. Final Output',
          value: trace.finalOutput,
          prev: trace.afterRegexRules,
        },
      ]
    : [];

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Regex Rules</h1>
          <p className="page-subtitle">
            Ordered pattern transforms supporting <span className="kbd">$1</span> capture groups
            and <span className="kbd">\n</span> newlines.
          </p>
        </div>

        <div className="io-actions" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            className="btn btn-sm"
            onClick={handleExportJson}
            disabled={rules.length === 0}
            title="Export regex rules as JSON"
          >
            <Download size={13} />
            <span>Export JSON</span>
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={saving}
            title="Import regex rules from JSON"
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
      </div>

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
            <span>One-Click Presets:</span>
          </span>
          {REGEX_PRESETS.map((preset) => {
            const added = isPresetAdded(preset);
            return (
              <button
                key={preset.id}
                type="button"
                className="btn btn-sm preset-chip"
                style={{ borderRadius: 999 }}
                disabled={saving || added}
                onClick={() => void handleApplyPreset(preset)}
                title={`/${preset.pattern}/${preset.flags} → ${preset.replacement}`}
              >
                {added ? <Check size={12} /> : <Plus size={12} />}
                <span>{preset.name}</span>
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

      <form className="card form-grid" onSubmit={handleSubmit}>
        <div className="toolbar">
          <input
            type="text"
            className="input"
            style={{ flex: 1, minWidth: 160 }}
            placeholder="Rule name (e.g. Issue IDs)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="flag-pills" role="group" aria-label="Regex flags">
            {AVAILABLE_FLAGS.map((f) => (
              <button
                key={f}
                type="button"
                className={`flag-pill ${flags.includes(f) ? 'active' : ''}`}
                onClick={() => toggleFlag(f)}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        <div className="toolbar">
          <input
            type="text"
            className="input mono"
            style={{ flex: 1, minWidth: 200 }}
            placeholder="Pattern (e.g. \\bjira\\s+(\\d+)\\b)"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
          />
          <input
            type="text"
            className="input mono"
            style={{ flex: 1, minWidth: 200 }}
            placeholder="Replacement (e.g. JIRA-$1)"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
          />
        </div>

        <div className="toolbar" style={{ justifyContent: 'space-between' }}>
          <div>
            {patternError && (
              <span className="chip danger">
                <AlertTriangle size={12} />
                <span>{patternError}</span>
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {editingId && (
              <button type="button" className="btn" onClick={resetForm}>
                <X size={14} />
                <span>Cancel</span>
              </button>
            )}
            <button
              type="submit"
              className="btn btn-primary"
              disabled={saving || !name.trim() || !pattern || Boolean(patternError)}
            >
              {editingId ? <Check size={14} /> : <Plus size={14} />}
              <span>{editingId ? 'Save Rule' : 'Add Rule'}</span>
            </button>
          </div>
        </div>
      </form>

      {rules.length === 0 ? (
        <div className="empty-state">
          <Regex size={22} style={{ color: 'var(--text-muted)' }} />
          <h2 className="empty-title">No regex rules yet</h2>
          <p className="empty-desc">
            Add ordered find-and-replace patterns that run deterministically right after
            dictionary and snippet expansion.
          </p>
        </div>
      ) : (
        <div className="list-stack">
          {rules.map((rule, idx) => {
            const rowErr = validateRegex(rule.pattern, rule.flags);
            return (
              <div key={rule.id} className="entry-row">
                <div className="entry-main">
                  <div className="entry-title">
                    <span style={{ opacity: rule.enabled ? 1 : 0.5 }}>{rule.name}</span>
                    <span className="chip mono">
                      /{rule.pattern}/{rule.flags}
                    </span>
                    {rowErr && (
                      <span className="chip danger">
                        <AlertTriangle size={11} />
                        <span>Syntax error</span>
                      </span>
                    )}
                  </div>
                  <div className="entry-sub mono" style={{ opacity: rule.enabled ? 1 : 0.5 }}>
                    → {rule.replacement === '' ? '(delete match)' : rule.replacement}
                  </div>
                </div>

                <div className="entry-controls">
                  <button
                    type="button"
                    className="icon-btn"
                    title="Move up"
                    disabled={idx === 0}
                    onClick={() => void handleMove(idx, -1)}
                  >
                    <ArrowUp size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title="Move down"
                    disabled={idx === rules.length - 1}
                    onClick={() => void handleMove(idx, 1)}
                  >
                    <ArrowDown size={14} />
                  </button>
                  <label className="switch" title={rule.enabled ? 'Enabled' : 'Disabled'}>
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={() => void handleToggle(rule)}
                    />
                    <span className="switch-track" />
                  </label>
                  <button
                    type="button"
                    className="icon-btn"
                    title="Edit"
                    onClick={() => startEdit(rule)}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn danger"
                    title="Delete"
                    onClick={() => void handleDelete(rule.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <section className="card form-grid" aria-label="Live Pipeline Tester">
        <div className="toolbar" style={{ justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Live Pipeline Tester</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Inspect how sample ASR output transforms across every zero-LLM stage.
            </div>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void runPipelineTest(sampleInput, sampleApp)}
          >
            <Play size={13} />
            <span>Run Test</span>
          </button>
        </div>

        <div className="toolbar">
          <textarea
            className="textarea"
            style={{ flex: 2, minHeight: 62 }}
            placeholder="Type sample ASR text…"
            value={sampleInput}
            onChange={(e) => setSampleInput(e.target.value)}
          />
          <input
            type="text"
            className="input"
            style={{ flex: 1, minWidth: 160, alignSelf: 'flex-start' }}
            placeholder="Optional app name (e.g. slack)"
            value={sampleApp}
            onChange={(e) => setSampleApp(e.target.value)}
          />
        </div>

        {trace && (
          <>
            <div className="toolbar" style={{ gap: 8 }}>
              <span
                className={`chip ${trace.matchedDictionaryIds.length > 0 ? 'accent' : ''}`}
              >
                Dictionary: {trace.matchedDictionaryIds.length} matched
              </span>
              <span className={`chip ${trace.matchedSnippetIds.length > 0 ? 'accent' : ''}`}>
                Snippets: {trace.matchedSnippetIds.length} matched
              </span>
              <span
                className={`chip ${trace.appliedRegexRuleIds.length > 0 ? 'accent' : ''}`}
              >
                Regex: {trace.appliedRegexRuleIds.length} matched
              </span>
              <span
                className={`chip ${trace.finalOutput !== trace.input ? 'success' : ''}`}
                style={{ marginLeft: 'auto' }}
              >
                {trace.finalOutput !== trace.input
                  ? 'Output differs from raw input'
                  : 'Unchanged from raw input'}
              </span>
            </div>

            <div className="pipeline-grid">
              {stages.map((s, idx) => {
                const changed = s.value !== s.prev;
                const isFinalAndModified =
                  idx === stages.length - 1 && trace.finalOutput !== trace.input;
                return (
                  <div
                    key={s.label}
                    className={`stage-card ${changed || isFinalAndModified ? 'changed' : ''}`}
                    style={
                      isFinalAndModified
                        ? {
                            borderColor: 'var(--success)',
                            background: 'rgba(34, 197, 94, 0.06)',
                          }
                        : undefined
                    }
                  >
                    <div className="stage-label">
                      <span>{s.label}</span>
                      <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                        {changed && <span className="chip accent">Changed</span>}
                        {isFinalAndModified && <span className="chip success">Modified</span>}
                      </div>
                    </div>
                    <div className="stage-text">
                      {s.value || <span style={{ opacity: 0.4 }}>(empty)</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </section>
    </>
  );
};
