import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, AppWindow, Calendar, Coins, Gauge, Info } from 'lucide-react';
import type { TokenUsageStats } from '@shared/types';

function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString();
}

function formatCompactTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function formatDayLabel(dateStr: string): string {
  // Expects YYYY-MM-DD
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    return `${Number(parts[1])}/${Number(parts[2])}`;
  }
  return dateStr;
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

const EMPTY_STATS: TokenUsageStats = {
  allTime: {
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    dictations: 0,
    measuredDictations: 0,
  },
  today: { totalTokens: 0, promptTokens: 0, completionTokens: 0, dictations: 0 },
  last7Days: { totalTokens: 0, promptTokens: 0, completionTokens: 0, dictations: 0 },
  byApp: [],
  byDay: [],
  recent: [],
};

export const TokensPage: React.FC = () => {
  const [stats, setStats] = useState<TokenUsageStats>(EMPTY_STATS);
  const [loading, setLoading] = useState(true);

  const loadTokenStats = useCallback(async () => {
    try {
      const next = await window.wisperHub?.getTokenStats();
      if (next) setStats(next);
    } catch {
      // Ignore transient IPC errors
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTokenStats();
    const unsub = window.wisperHub?.onHistoryAdded(() => {
      void loadTokenStats();
    });
    return () => unsub?.();
  }, [loadTokenStats]);

  const avgTokensPerDictation = useMemo(() => {
    if (stats.allTime.dictations <= 0) return 0;
    return Math.round(stats.allTime.totalTokens / stats.allTime.dictations);
  }, [stats.allTime.dictations, stats.allTime.totalTokens]);

  const estimatedCount = Math.max(0, stats.allTime.dictations - stats.allTime.measuredDictations);

  const chartDays = useMemo(() => stats.byDay.slice(-14), [stats.byDay]);
  const maxDayTokens = useMemo(
    () => Math.max(1, ...chartDays.map((d) => d.totalTokens)),
    [chartDays],
  );

  const topApps = useMemo(() => stats.byApp.slice(0, 8), [stats.byApp]);
  const maxAppTokens = useMemo(
    () => Math.max(1, ...topApps.map((a) => a.totalTokens)),
    [topApps],
  );

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Tokens</h1>
          <p className="page-subtitle">
            Local LLM token usage across dictations, prompt vs completion breakdown, and top apps.
          </p>
        </div>

        {stats.allTime.dictations > 0 && (
          <span className={`chip ${estimatedCount > 0 ? 'warning' : 'success'}`}>
            <Info size={13} />
            <span>
              {estimatedCount > 0
                ? `${stats.allTime.measuredDictations} measured · ${estimatedCount} estimated`
                : `All ${stats.allTime.measuredDictations} dictations measured`}
            </span>
          </span>
        )}
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label">
            <span>All-Time Tokens</span>
            <Coins size={15} />
          </div>
          <div className="stat-value">{formatTokens(stats.allTime.totalTokens)}</div>
          <div className="stat-meta">
            {formatCompactTokens(stats.allTime.promptTokens)} prompt ·{' '}
            {formatCompactTokens(stats.allTime.completionTokens)} completion
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">
            <span>Today&apos;s Tokens</span>
            <Activity size={15} />
          </div>
          <div className="stat-value">{formatTokens(stats.today.totalTokens)}</div>
          <div className="stat-meta">
            {stats.today.dictations} {stats.today.dictations === 1 ? 'dictation' : 'dictations'}
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">
            <span>Last 7 Days</span>
            <Calendar size={15} />
          </div>
          <div className="stat-value">{formatTokens(stats.last7Days.totalTokens)}</div>
          <div className="stat-meta">
            {stats.last7Days.dictations}{' '}
            {stats.last7Days.dictations === 1 ? 'dictation' : 'dictations'}
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">
            <span>Avg / Dictation</span>
            <Gauge size={15} />
          </div>
          <div className="stat-value">{formatTokens(avgTokensPerDictation)}</div>
          <div className="stat-meta">
            {estimatedCount > 0
              ? 'Includes Est. older rows'
              : `${stats.allTime.dictations} total dictations`}
          </div>
        </div>
      </div>

      {estimatedCount > 0 && (
        <div className="tokens-note">
          <Info size={14} style={{ flexShrink: 0, color: 'var(--warning)' }} />
          <span>
            Older history rows recorded before token tracking are marked <strong>Est.</strong> and
            approximated from word count. New dictations report exact prompt and completion tokens
            from llama-server.
          </span>
        </div>
      )}

      <section className="card tokens-section">
        <div className="tokens-section-header">
          <div>
            <h2 className="tokens-section-title">14-Day Daily Usage</h2>
            <p className="tokens-section-sub">Prompt + completion tokens burned per day</p>
          </div>
          <div className="tokens-legend">
            <span className="tokens-legend-item">
              <span className="tokens-legend-dot prompt" />
              Prompt
            </span>
            <span className="tokens-legend-item">
              <span className="tokens-legend-dot completion" />
              Completion
            </span>
          </div>
        </div>

        {loading && chartDays.length === 0 ? (
          <div className="tokens-empty-inline">Loading token usage…</div>
        ) : chartDays.length === 0 ? (
          <div className="tokens-empty-inline">No daily token data yet.</div>
        ) : (
          <div className="tokens-chart" role="img" aria-label="14-day daily token usage bar chart">
            {chartDays.map((day) => {
              const totalPct = Math.max(
                day.totalTokens > 0 ? 4 : 0,
                (day.totalTokens / maxDayTokens) * 100,
              );
              const promptShare =
                day.totalTokens > 0 ? (day.promptTokens / day.totalTokens) * 100 : 0;
              const completionShare =
                day.totalTokens > 0 ? Math.max(0, 100 - promptShare) : 0;
              const title = `${day.date}: ${formatTokens(day.totalTokens)} tokens (${formatTokens(day.promptTokens)} prompt, ${formatTokens(day.completionTokens)} completion) · ${day.dictations} dictations`;

              return (
                <div key={day.date} className="tokens-bar-col" title={title}>
                  <span className="tokens-bar-value">
                    {day.totalTokens > 0 ? formatCompactTokens(day.totalTokens) : ''}
                  </span>
                  <div className="tokens-bar-track">
                    <div className="tokens-bar-stack" style={{ height: `${totalPct}%` }}>
                      {completionShare > 0 && (
                        <div
                          className="tokens-bar-seg completion"
                          style={{ height: `${completionShare}%` }}
                        />
                      )}
                      {promptShare > 0 && (
                        <div
                          className="tokens-bar-seg prompt"
                          style={{ height: `${promptShare}%` }}
                        />
                      )}
                    </div>
                  </div>
                  <span className="tokens-bar-label">{formatDayLabel(day.date)}</span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="card tokens-section">
        <div className="tokens-section-header">
          <div>
            <h2 className="tokens-section-title">Top Apps</h2>
            <p className="tokens-section-sub">Tokens burned by target application</p>
          </div>
          <AppWindow size={16} style={{ color: 'var(--text-muted)' }} />
        </div>

        {topApps.length === 0 ? (
          <div className="tokens-empty-inline">No app breakdown available yet.</div>
        ) : (
          <div className="tokens-apps-list">
            {topApps.map((app) => {
              const pct = Math.max(2, (app.totalTokens / maxAppTokens) * 100);
              return (
                <div key={app.appName || 'unknown'} className="tokens-app-row">
                  <div className="tokens-app-meta">
                    <span className="tokens-app-name">{app.appName || 'Unknown App'}</span>
                    <span className="tokens-app-stats">
                      {app.dictations} {app.dictations === 1 ? 'dictation' : 'dictations'} ·{' '}
                      <strong>{formatTokens(app.totalTokens)}</strong> tokens
                    </span>
                  </div>
                  <div className="tokens-app-bar-track">
                    <div className="tokens-app-bar-fill" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="card tokens-section">
        <div className="tokens-section-header">
          <div>
            <h2 className="tokens-section-title">Recent Dictations</h2>
            <p className="tokens-section-sub">Per-utterance token breakdown</p>
          </div>
        </div>

        {stats.recent.length === 0 ? (
          <div className="tokens-empty-inline">No dictations recorded yet.</div>
        ) : (
          <div className="tokens-table-wrap">
            <table className="tokens-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>App</th>
                  <th className="num">Words</th>
                  <th className="num">Prompt</th>
                  <th className="num">Completion</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {stats.recent.map((row) => (
                  <tr key={row.id} title={row.textPreview || undefined}>
                    <td className="tokens-cell-time">{formatTimestamp(row.timestamp)}</td>
                    <td className="tokens-cell-app">{row.appName || 'Unknown'}</td>
                    <td className="num">{row.numWords}</td>
                    <td className="num">{formatTokens(row.promptTokens)}</td>
                    <td className="num">{formatTokens(row.completionTokens)}</td>
                    <td className="num tokens-cell-total">
                      <span>{formatTokens(row.totalTokens)}</span>
                      {row.estimated && (
                        <span
                          className="chip warning tokens-est-badge"
                          title="Estimated from word count"
                        >
                          Est.
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
};
