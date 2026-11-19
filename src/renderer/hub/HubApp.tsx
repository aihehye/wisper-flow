import React, { useCallback, useEffect, useState } from 'react';
import {
  BookOpen,
  Cpu,
  Home,
  Laptop,
  Moon,
  Palette,
  Regex,
  Settings,
  Sun,
  Zap,
} from 'lucide-react';
import { createDefaultSettings } from '@shared/defaults';
import type {
  AppSettings,
  ModelStatus,
  OmarchyEnvironment,
  OmarchyPalette,
  ThemeMode,
  UsageStats,
} from '@shared/types';
import type { HubPage, SettingsTab } from '../../preload/hubPreload';
import { audioPlayer } from '../shared/audioPlayer';
import { enumerateAudioInputs } from '../hud/micCapture';
import { HomePage } from './pages/HomePage';
import { DictionaryPage } from './pages/DictionaryPage';
import { SnippetsPage } from './pages/SnippetsPage';
import { RegexRulesPage } from './pages/RegexRulesPage';
import { SettingsPage } from './pages/SettingsPage';

const OMARCHY_CSS_VARS = [
  '--bg',
  '--bg-elevated',
  '--surface',
  '--surface-hover',
  '--border',
  '--border-strong',
  '--text',
  '--text-muted',
  '--accent',
  '--accent-fg',
  '--danger',
  '--success',
  '--warning',
];

function parseHex(hex?: string): [number, number, number] | null {
  if (!hex) return null;
  const clean = hex.trim().replace(/^#/, '');
  if (clean.length === 3) {
    const r = parseInt(clean[0] + clean[0], 16);
    const g = parseInt(clean[1] + clean[1], 16);
    const b = parseInt(clean[2] + clean[2], 16);
    return Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) ? null : [r, g, b];
  }
  if (clean.length >= 6) {
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) ? null : [r, g, b];
  }
  return null;
}

function toHex(rgb: [number, number, number]): string {
  return (
    '#' +
    rgb
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
      .join('')
  );
}

function mixHex(a: string, b: string, weightB: number): string {
  const ra = parseHex(a);
  const rb = parseHex(b);
  if (!ra || !rb) return a;
  const w = Math.max(0, Math.min(1, weightB));
  return toHex([
    ra[0] * (1 - w) + rb[0] * w,
    ra[1] * (1 - w) + rb[1] * w,
    ra[2] * (1 - w) + rb[2] * w,
  ]);
}

function luminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0.1;
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function rgbaFromHex(hex: string, alpha: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return `rgba(255, 255, 255, ${alpha})`;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

function applyThemeToDocument(theme: ThemeMode, palette: OmarchyPalette | null): void {
  const root = document.documentElement;
  for (const v of OMARCHY_CSS_VARS) {
    root.style.removeProperty(v);
  }

  if (theme === 'omarchy' && palette) {
    const bg = palette.background || palette.colors?.background || '#0c0d10';
    const fg = palette.foreground || palette.colors?.foreground || '#f3f4f6';
    const isLight = palette.mode ? palette.mode === 'light' : luminance(bg) > 0.45;
    const accent =
      palette.accent ||
      palette.colors?.accent ||
      palette.colors?.color4 ||
      palette.colors?.color12 ||
      fg;
    const accentFg = luminance(accent) > 0.45 ? '#0c0d10' : '#ffffff';

    root.setAttribute('data-theme', isLight ? 'light' : 'dark');
    root.style.setProperty('--bg', bg);
    root.style.setProperty('--bg-elevated', mixHex(bg, fg, isLight ? 0.03 : 0.045));
    root.style.setProperty('--surface', mixHex(bg, fg, isLight ? 0.05 : 0.08));
    root.style.setProperty('--surface-hover', mixHex(bg, fg, isLight ? 0.09 : 0.13));
    root.style.setProperty('--border', rgbaFromHex(fg, isLight ? 0.1 : 0.1));
    root.style.setProperty('--border-strong', rgbaFromHex(fg, isLight ? 0.22 : 0.22));
    root.style.setProperty('--text', fg);
    root.style.setProperty('--text-muted', mixHex(fg, bg, 0.42));
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--accent-fg', accentFg);
    if (palette.colors?.color1) root.style.setProperty('--danger', palette.colors.color1);
    if (palette.colors?.color2) root.style.setProperty('--success', palette.colors.color2);
    if (palette.colors?.color3) root.style.setProperty('--warning', palette.colors.color3);
    return;
  }

  if (theme === 'system') {
    const prefersLight =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-color-scheme: light)').matches;
    root.setAttribute('data-theme', prefersLight ? 'light' : 'dark');
    return;
  }

  root.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
}

function formatDeviceShortName(status: ModelStatus | null): string {
  if (!status) return 'GPU';
  const raw = status.activeDeviceName || status.activeDeviceId || 'Auto';
  const rtxMatch = raw.match(/(RTX\s*\d{4}(?:\s*Ti|\s*SUPER)?)/i);
  if (rtxMatch) return rtxMatch[1].toUpperCase();
  if (raw.length > 18) return `${raw.slice(0, 17)}…`;
  return raw;
}

function formatModelStateLabel(status: ModelStatus | null): string {
  if (!status) return 'Checking…';
  switch (status.state) {
    case 'ready':
      return 'Ready';
    case 'starting':
      return 'Starting…';
    case 'downloading':
      return status.downloadProgress
        ? `Downloading ${Math.round(status.downloadProgress.percent)}%`
        : 'Downloading…';
    case 'missing':
      return 'Model missing';
    case 'error':
      return 'Error';
    default:
      return 'Idle';
  }
}

export const HubApp: React.FC = () => {
  const [page, setPage] = useState<HubPage>('home');
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [settings, setSettings] = useState<AppSettings>(() => createDefaultSettings('win32'));
  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null);
  const [omarchyEnv, setOmarchyEnv] = useState<OmarchyEnvironment | null>(null);
  const [palette, setPalette] = useState<OmarchyPalette | null>(null);
  const [stats, setStats] = useState<UsageStats>({
    totalWords: 0,
    totalDictations: 0,
    averageWpm: 0,
    streakDays: 0,
    timeSavedMinutes: 0,
    todayWords: 0,
  });

  const refreshStats = useCallback(async () => {
    try {
      const next = await window.wisperHub?.getStats();
      if (next) setStats(next);
    } catch {}
  }, []);

  const syncDevices = useCallback(async () => {
    const devices = await enumerateAudioInputs();
    try {
      await window.wisperHub?.setAudioDevices(devices);
    } catch {}
  }, []);

  useEffect(() => {
    let mounted = true;

    void (async () => {
      try {
        const [s, m, o, st] = await Promise.all([
          window.wisperHub?.getSettings(),
          window.wisperHub?.getModelStatus(),
          window.wisperHub?.getOmarchyStatus(),
          window.wisperHub?.getStats(),
        ]);
        if (!mounted) return;
        if (s) setSettings(s);
        if (m) setModelStatus(m);
        if (o) {
          setOmarchyEnv(o);
          setPalette(o.palette);
        }
        if (st) setStats(st);
      } catch {}
    })();

    void syncDevices();
    const onDevChange = () => {
      void syncDevices();
    };
    navigator.mediaDevices?.addEventListener?.('devicechange', onDevChange);

    const unsubSettings = window.wisperHub?.onSettingsChanged((next) => {
      if (mounted && next) setSettings(next);
    });
    const unsubModel = window.wisperHub?.onModelStatus((next) => {
      if (mounted && next) setModelStatus(next);
    });
    const unsubPalette = window.wisperHub?.onOmarchyPalette((next) => {
      if (mounted) setPalette(next);
    });
    const unsubHistory = window.wisperHub?.onHistoryAdded(() => {
      if (mounted) void refreshStats();
    });
    const unsubNav = window.wisperHub?.onNavigate((target) => {
      if (!mounted || !target) return;
      if (typeof target === 'string') {
        setPage(target);
      } else {
        setPage(target.page);
        if (target.settingsTab) setSettingsTab(target.settingsTab);
      }
    });
    const unsubSound = window.wisperHub?.onPlaySound(({ slot, dataUrl }) => {
      void audioPlayer.play(slot, dataUrl);
    });

    return () => {
      mounted = false;
      navigator.mediaDevices?.removeEventListener?.('devicechange', onDevChange);
      unsubSettings?.();
      unsubModel?.();
      unsubPalette?.();
      unsubHistory?.();
      unsubNav?.();
      unsubSound?.();
    };
  }, [refreshStats, syncDevices]);

  useEffect(() => {
    applyThemeToDocument(settings.theme, palette);
    if (settings.theme !== 'system') return;
    const mq = window.matchMedia?.('(prefers-color-scheme: light)');
    if (!mq) return;
    const handler = () => applyThemeToDocument('system', palette);
    mq.addEventListener?.('change', handler);
    return () => mq.removeEventListener?.('change', handler);
  }, [palette, settings.theme]);

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
    try {
      const updated = await window.wisperHub?.updateSettings(patch);
      if (updated) setSettings(updated);
    } catch {}
  }, []);

  const handleModelBadgeAction = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (modelStatus?.state === 'missing') {
        void window.wisperHub?.downloadModel().catch(() => {});
      } else {
        setPage('settings');
        setSettingsTab('model');
      }
    },
    [modelStatus?.state],
  );

  const navItems: Array<{ id: HubPage; label: string; icon: React.ReactNode }> = [
    { id: 'home', label: 'Home', icon: <Home size={16} /> },
    { id: 'dictionary', label: 'Dictionary', icon: <BookOpen size={16} /> },
    { id: 'snippets', label: 'Snippets', icon: <Zap size={16} /> },
    { id: 'regex', label: 'Regex Rules', icon: <Regex size={16} /> },
    { id: 'settings', label: 'Settings', icon: <Settings size={16} /> },
  ];

  const isOmarchyTheme = settings.theme === 'omarchy';

  return (
    <div className="hub-shell">
      <aside className="hub-sidebar">
        <div>
          <div className="hub-brand">
            <div className="hub-brand-mark">WF</div>
            <div className="hub-brand-text">
              <span className="hub-brand-title">Wisper Flow</span>
              <span className="hub-brand-sub">Local · Zero-LLM</span>
            </div>
          </div>

          <nav className="hub-nav" aria-label="Primary">
            {navItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`hub-nav-item ${page === item.id ? 'active' : ''}`}
                onClick={() => setPage(item.id)}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
        </div>

        <div className="hub-sidebar-footer">
          <div className="theme-switcher" role="group" aria-label="Theme">
            <button
              type="button"
              className={`theme-btn ${settings.theme === 'dark' ? 'active' : ''}`}
              onClick={() => void updateSettings({ theme: 'dark' })}
              title="Dark theme"
            >
              <Moon size={12} />
              <span>Dark</span>
            </button>
            <button
              type="button"
              className={`theme-btn ${settings.theme === 'light' ? 'active' : ''}`}
              onClick={() => void updateSettings({ theme: 'light' })}
              title="Light theme"
            >
              <Sun size={12} />
              <span>Light</span>
            </button>
            <button
              type="button"
              className={`theme-btn ${isOmarchyTheme ? 'active' : ''}`}
              onClick={() => void updateSettings({ theme: 'omarchy' })}
              title="Sync with Omarchy palette"
            >
              {omarchyEnv?.isOmarchy ? <Palette size={12} /> : <Laptop size={12} />}
              <span>Omarchy</span>
            </button>
          </div>

          <div
            className="gpu-badge-card"
            role="button"
            tabIndex={0}
            onClick={() => {
              setPage('settings');
              setSettingsTab('model');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                setPage('settings');
                setSettingsTab('model');
              }
            }}
          >
            <div className="gpu-badge-top">
              <div className="gpu-badge-label">
                <Cpu size={14} />
                <span>{formatDeviceShortName(modelStatus)}</span>
              </div>
              <span className={`status-dot ${modelStatus?.state || 'uninitialized'}`} />
            </div>

            <div className="gpu-badge-sub">{formatModelStateLabel(modelStatus)}</div>

            {modelStatus?.state === 'downloading' && modelStatus.downloadProgress && (
              <div className="mini-progress-track">
                <div
                  className="mini-progress-fill"
                  style={{ width: `${Math.min(100, modelStatus.downloadProgress.percent)}%` }}
                />
              </div>
            )}

            {modelStatus?.state === 'missing' && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={handleModelBadgeAction}
              >
                Download Model
              </button>
            )}
          </div>
        </div>
      </aside>

      <main className="hub-main">
        <div className="hub-container">
          {page === 'home' && (
            <HomePage
              stats={stats}
              settings={settings}
              omarchyEnv={omarchyEnv}
              onStatsChanged={refreshStats}
            />
          )}
          {page === 'dictionary' && <DictionaryPage />}
          {page === 'snippets' && <SnippetsPage />}
          {page === 'regex' && <RegexRulesPage />}
          {page === 'settings' && (
            <SettingsPage
              activeTab={settingsTab}
              onTabChange={setSettingsTab}
              settings={settings}
              onUpdateSettings={updateSettings}
              modelStatus={modelStatus}
              omarchyEnv={omarchyEnv}
              onOmarchyUpdated={setOmarchyEnv}
            />
          )}
        </div>
      </main>
    </div>
  );
};
