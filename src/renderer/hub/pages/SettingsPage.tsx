import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FolderOpen,
  Mic,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
  Volume2,
  Wrench,
} from 'lucide-react';
import { createDefaultSettings, RUMBLE_LANGUAGES } from '@shared/defaults';
import type {
  AppSettings,
  AudioDeviceOption,
  DockPosition,
  LinuxPasteBackend,
  MicProfile,
  ModelStatus,
  OmarchyEnvironment,
  ShortcutsConfig,
  SoundSlot,
  SoundSlotStatus,
  ThemeMode,
} from '@shared/types';
import type { SettingsTab, SmokeTestResult } from '../../../preload/hubPreload';
import { enumerateAudioInputs, startMicLevelMonitor } from '../../hud/micCapture';

interface SettingsPageProps {
  activeTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  settings: AppSettings;
  onUpdateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  modelStatus: ModelStatus | null;
  omarchyEnv: OmarchyEnvironment | null;
  onOmarchyUpdated: (env: OmarchyEnvironment) => void;
}

const SHORTCUT_ROWS: Array<{
  field: keyof ShortcutsConfig;
  label: string;
  desc: string;
}> = [
  {
    field: 'pushToTalk',
    label: 'Push-to-Talk',
    desc: 'Hold to speak, release to transcribe and paste.',
  },
  {
    field: 'handsFree',
    label: 'Hands-Free Toggle',
    desc: 'Press to lock recording on, press again to stop.',
  },
  {
    field: 'cancel',
    label: 'Cancel Dictation',
    desc: 'Abort an active recording without transcribing.',
  },
  {
    field: 'pasteLast',
    label: 'Paste Last Dictation',
    desc: 'Re-paste your most recent transcript.',
  },
  {
    field: 'copyLast',
    label: 'Copy Last Dictation',
    desc: 'Copy your most recent transcript to clipboard.',
  },
];

const SOUND_SLOT_LABELS: Record<SoundSlot, string> = {
  start: 'Dictation Start',
  stop: 'Dictation Stop',
  popoLock: 'Hands-Free Lock',
  paste: 'Paste Complete',
  error: 'Error',
  alert: 'Warning / Alert',
  success: 'Success',
  achievement: 'Achievement',
};

const ALL_SOUND_SLOTS: SoundSlot[] = [
  'start',
  'stop',
  'popoLock',
  'paste',
  'error',
  'alert',
  'success',
  'achievement',
];

function formatKeyComboFromEvent(e: KeyboardEvent): string | null {
  const modifierOnly = ['Control', 'Shift', 'Alt', 'Meta', 'OS'].includes(e.key);
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Win');

  if (modifierOnly) {
    if (e.code === 'AltRight') return 'RightAlt';
    if (e.code === 'ControlRight') return 'RightCtrl';
    return null;
  }

  let keyName = e.key;
  if (keyName === ' ') keyName = 'Space';
  else if (keyName === 'Escape') keyName = 'Esc';
  else if (keyName.length === 1) keyName = keyName.toUpperCase();

  parts.push(keyName);
  return parts.join('+');
}

function getSelectedLanguageValue(current: string): string {
  if (!current || current === 'auto') return 'auto';
  const exact = RUMBLE_LANGUAGES.find(
    (l) => l.name.toLowerCase() === current.toLowerCase() || l.code.toLowerCase() === current.toLowerCase(),
  );
  if (!exact) return current;
  return exact.code === 'auto' ? 'auto' : exact.name;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({
  activeTab,
  onTabChange,
  settings,
  onUpdateSettings,
  modelStatus,
  omarchyEnv,
  onOmarchyUpdated,
}) => {
  const [capturingField, setCapturingField] = useState<keyof ShortcutsConfig | null>(null);
  const [audioDevices, setAudioDevices] = useState<AudioDeviceOption[]>([
    { id: 'default', label: 'System Default' },
  ]);
  const [micTesting, setMicTesting] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [micDead, setMicDead] = useState(false);
  const stopMonitorRef = useRef<(() => Promise<void>) | null>(null);

  const [smokeResult, setSmokeResult] = useState<SmokeTestResult | null>(null);
  const [smokeRunning, setSmokeRunning] = useState(false);

  const [soundStatuses, setSoundStatuses] = useState<SoundSlotStatus[]>([]);
  const [lowercaseAppInput, setLowercaseAppInput] = useState('');

  const [omarchyBusy, setOmarchyBusy] = useState(false);
  const [showLuaSnippet, setShowLuaSnippet] = useState(false);
  const [showConfSnippet, setShowConfSnippet] = useState(false);
  const [copiedSnippet, setCopiedSnippet] = useState<'lua' | 'conf' | null>(null);

  const platformDefaults = useMemo(
    () => createDefaultSettings(omarchyEnv?.platform === 'linux' ? 'linux' : 'win32'),
    [omarchyEnv?.platform],
  );

  const refreshAudioDevices = useCallback(async () => {
    const enumerated = await enumerateAudioInputs();
    setAudioDevices(enumerated);
    try {
      await window.wisperHub?.setAudioDevices(enumerated);
    } catch {}
  }, []);

  const refreshSoundStatuses = useCallback(async () => {
    try {
      const list = await window.wisperHub?.listSoundStatuses();
      if (Array.isArray(list)) setSoundStatuses(list);
    } catch {}
  }, []);

  useEffect(() => {
    void refreshAudioDevices();
    void refreshSoundStatuses();
  }, [refreshAudioDevices, refreshSoundStatuses, settings.customSoundDir]);

  // Stop mic monitor if user leaves General tab or unmounts
  useEffect(() => {
    if (activeTab !== 'general' && stopMonitorRef.current) {
      void stopMonitorRef.current();
      stopMonitorRef.current = null;
      setMicTesting(false);
      setMicLevel(0);
    }
  }, [activeTab]);

  useEffect(() => {
    return () => {
      if (stopMonitorRef.current) {
        void stopMonitorRef.current();
        stopMonitorRef.current = null;
      }
      if (capturingField) {
        void window.wisperHub?.captureShortcutStop().catch(() => {});
      }
    };
  }, [capturingField]);

  // Shortcut capture lifecycle
  useEffect(() => {
    if (!capturingField) return;

    const finishCapture = async (shortcut: string) => {
      const field = capturingField;
      setCapturingField(null);
      try {
        await window.wisperHub?.captureShortcutStop();
      } catch {}
      await onUpdateSettings({
        shortcuts: {
          ...settings.shortcuts,
          [field]: shortcut,
        },
      });
    };

    const unsubCaptured = window.wisperHub?.onShortcutCaptured((payload) => {
      const shortcut = typeof payload === 'string' ? payload : payload?.shortcut;
      if (shortcut) {
        void finishCapture(shortcut);
      }
    });

    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape' && capturingField !== 'cancel') {
        setCapturingField(null);
        void window.wisperHub?.captureShortcutStop().catch(() => {});
        return;
      }
      const combo = formatKeyComboFromEvent(e);
      if (combo) {
        void finishCapture(combo);
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      unsubCaptured?.();
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [capturingField, onUpdateSettings, settings.shortcuts]);

  const beginShortcutCapture = async (field: keyof ShortcutsConfig) => {
    setCapturingField(field);
    try {
      await window.wisperHub?.captureShortcutStart(field);
    } catch {}
  };

  const cancelShortcutCapture = async () => {
    setCapturingField(null);
    try {
      await window.wisperHub?.captureShortcutStop();
    } catch {}
  };

  const toggleMicMonitor = async () => {
    if (micTesting) {
      if (stopMonitorRef.current) {
        await stopMonitorRef.current();
        stopMonitorRef.current = null;
      }
      setMicTesting(false);
      setMicLevel(0);
      setMicDead(false);
      return;
    }

    try {
      setMicTesting(true);
      setMicDead(false);
      stopMonitorRef.current = await startMicLevelMonitor(
        settings.microphoneDeviceId,
        settings.whisperModeBoost,
        (level, peakZero) => {
          setMicLevel(level);
          setMicDead(peakZero);
        },
        settings.micProfile,
      );
    } catch {
      setMicTesting(false);
      setMicDead(true);
    }
  };

  const handleRunSmokeTest = async () => {
    setSmokeRunning(true);
    setSmokeResult(null);
    try {
      const res = await window.wisperHub?.testModelSmoke();
      if (res) setSmokeResult(res);
    } catch (err) {
      setSmokeResult({
        ok: false,
        error: err instanceof Error ? err.message : 'Smoke test failed',
      });
    } finally {
      setSmokeRunning(false);
    }
  };

  const handleBrowseSoundDir = async () => {
    try {
      const selected = await window.wisperHub?.browseSoundDir();
      if (selected) {
        await onUpdateSettings({ customSoundDir: selected });
        await refreshSoundStatuses();
      }
    } catch {}
  };

  const handleAddLowercaseApp = (e: React.FormEvent) => {
    e.preventDefault();
    const val = lowercaseAppInput.trim();
    if (!val) return;
    if (settings.cleanup.allLowercaseApps.includes(val)) {
      setLowercaseAppInput('');
      return;
    }
    void onUpdateSettings({
      cleanup: {
        ...settings.cleanup,
        allLowercaseApps: [...settings.cleanup.allLowercaseApps, val],
      },
    });
    setLowercaseAppInput('');
  };

  const handleRemoveLowercaseApp = (appName: string) => {
    void onUpdateSettings({
      cleanup: {
        ...settings.cleanup,
        allLowercaseApps: settings.cleanup.allLowercaseApps.filter((a) => a !== appName),
      },
    });
  };

  const handleCopySnippet = async (kind: 'lua' | 'conf', text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedSnippet(kind);
      window.setTimeout(() => {
        setCopiedSnippet((cur) => (cur === kind ? null : cur));
      }, 1500);
    } catch {}
  };

  const soundStatusMap = useMemo(() => {
    const map = new Map<SoundSlot, SoundSlotStatus>();
    for (const item of soundStatuses) {
      map.set(item.slot, item);
    }
    return map;
  }, [soundStatuses]);

  const micOptions = useMemo(() => {
    if (audioDevices.some((d) => d.id === settings.microphoneDeviceId)) {
      return audioDevices;
    }
    return [
      ...audioDevices,
      { id: settings.microphoneDeviceId, label: settings.microphoneDeviceId },
    ];
  }, [audioDevices, settings.microphoneDeviceId]);

  const isWindowsPreview = omarchyEnv ? !omarchyEnv.isLinux : false;
  const envBadgeText = omarchyEnv
    ? omarchyEnv.omarchyVersion === 'v4-lua'
      ? 'Omarchy v4 Lua'
      : omarchyEnv.omarchyVersion === 'v3-conf'
        ? 'Omarchy v3 Conf'
        : omarchyEnv.omarchyVersion === 'hyprland-conf'
          ? 'Hyprland'
          : 'Windows Preview'
    : 'Detecting…';

  const paletteSwatches = useMemo(() => {
    if (!omarchyEnv?.palette) return [];
    const entries: Array<[string, string]> = [];
    if (omarchyEnv.palette.background) entries.push(['background', omarchyEnv.palette.background]);
    if (omarchyEnv.palette.foreground) entries.push(['foreground', omarchyEnv.palette.foreground]);
    if (omarchyEnv.palette.accent) entries.push(['accent', omarchyEnv.palette.accent]);
    for (const [k, v] of Object.entries(omarchyEnv.palette.colors || {})) {
      if (!entries.some(([ek]) => ek === k)) entries.push([k, v]);
    }
    return entries.slice(0, 19);
  }, [omarchyEnv]);

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">
            Configure shortcuts, local GPU transcription, sounds, and Omarchy integration.
          </p>
        </div>

        <div className="tabs" role="tablist">
          {(
            [
              ['general', 'General'],
              ['model', 'Model & GPU'],
              ['system', 'System & Sounds'],
              ['cleanup', 'Cleanup Rules'],
              ['omarchy', 'Omarchy & Linux'],
            ] as Array<[SettingsTab, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={activeTab === id}
              className={`tab-btn ${activeTab === id ? 'active' : ''}`}
              onClick={() => onTabChange(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'general' && (
        <>
          <section className="settings-group">
            <div className="settings-group-header">
              <span>Keyboard Shortcuts</span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void onUpdateSettings({ shortcuts: platformDefaults.shortcuts })}
              >
                <RotateCcw size={12} />
                <span>Reset All</span>
              </button>
            </div>

            {SHORTCUT_ROWS.map((row) => {
              const isCapturing = capturingField === row.field;
              const current = settings.shortcuts[row.field];
              const defVal = platformDefaults.shortcuts[row.field];
              return (
                <div key={row.field} className="setting-row">
                  <div className="setting-info">
                    <div className="setting-label">{row.label}</div>
                    <div className="setting-desc">{row.desc}</div>
                  </div>
                  <div className="setting-control">
                    <span className="kbd">{isCapturing ? 'Press keys…' : current}</span>
                    {isCapturing ? (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => void cancelShortcutCapture()}
                      >
                        Cancel
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => void beginShortcutCapture(row.field)}
                      >
                        Rebind
                      </button>
                    )}
                    {current !== defVal && (
                      <button
                        type="button"
                        className="icon-btn"
                        title={`Reset to ${defVal}`}
                        onClick={() =>
                          void onUpdateSettings({
                            shortcuts: { ...settings.shortcuts, [row.field]: defVal },
                          })
                        }
                      >
                        <RotateCcw size={13} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </section>

          <section className="settings-group">
            <div className="settings-group-header">
              <span>Microphone & Language</span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void refreshAudioDevices()}
              >
                <RefreshCw size={12} />
                <span>Refresh Mics</span>
              </button>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <div className="setting-label">Input Microphone</div>
                <div className="setting-desc">
                  Choose the capture device used for 16 kHz dictation audio.
                </div>
              </div>
              <div className="setting-control" style={{ minWidth: 250 }}>
                <select
                  className="select"
                  value={settings.microphoneDeviceId}
                  onChange={(e) => void onUpdateSettings({ microphoneDeviceId: e.target.value })}
                >
                  {micOptions.map((dev) => (
                    <option key={dev.id} value={dev.id}>
                      {dev.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <div className="setting-label">Live Mic Level Test</div>
                <div className="setting-desc">
                  {micTesting && micDead
                    ? 'No signal detected yet — check hardware mute or selected device.'
                    : 'Verify input gain before dictating.'}
                </div>
              </div>
              <div className="setting-control">
                <div className="mic-meter-track" aria-label="Microphone level meter">
                  <div
                    className="mic-meter-fill"
                    style={{
                      width: `${Math.min(100, Math.round(micLevel * 100))}%`,
                      background: micDead ? 'var(--danger)' : 'var(--success)',
                    }}
                  />
                </div>
                <button type="button" className="btn btn-sm" onClick={() => void toggleMicMonitor()}>
                  {micTesting ? <Square size={12} /> : <Mic size={12} />}
                  <span>{micTesting ? 'Stop' : 'Test Mic'}</span>
                </button>
              </div>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <div className="setting-label">Microphone Environment</div>
                <div className="setting-desc">
                  {settings.micProfile === 'quiet'
                    ? 'Quiet Room: disables browser noise suppression & echo cancellation and uses a whisper-safe silence threshold.'
                    : 'Outside / Noisy: enables echo cancellation & noise suppression for loud environments.'}
                </div>
              </div>
              <div className="setting-control">
                <div className="flag-pills" role="group" aria-label="Microphone environment">
                  {(
                    [
                      { value: 'quiet' as MicProfile, label: 'Quiet Room' },
                      { value: 'noisy' as MicProfile, label: 'Outside' },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className={`btn btn-sm ${settings.micProfile === opt.value ? 'btn-primary' : ''}`}
                      onClick={() => void onUpdateSettings({ micProfile: opt.value })}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <div className="setting-label">Whisper Mode</div>
                <div className="setting-desc">
                  Applies a clean soft-limited gain boost for quiet late-night speech (always active in Quiet Room).
                </div>
              </div>
              <div className="setting-control">
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={settings.whisperModeBoost}
                    onChange={(e) =>
                      void onUpdateSettings({ whisperModeBoost: e.target.checked })
                    }
                  />
                  <span className="switch-track" />
                </label>
              </div>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <div className="setting-label">Spoken Language</div>
                <div className="setting-desc">
                  Rumble-2-Flash supports 45 languages plus automatic detection.
                </div>
              </div>
              <div className="setting-control" style={{ minWidth: 250 }}>
                <select
                  className="select"
                  value={getSelectedLanguageValue(settings.language)}
                  onChange={(e) => void onUpdateSettings({ language: e.target.value })}
                >
                  {RUMBLE_LANGUAGES.map((lang) => {
                    const val = lang.code === 'auto' ? 'auto' : lang.name;
                    return (
                      <option key={lang.code} value={val}>
                        {lang.name}
                      </option>
                    );
                  })}
                </select>
              </div>
            </div>
          </section>
        </>
      )}

      {activeTab === 'model' && (
        <>
          <section className="settings-group">
            <div className="settings-group-header">
              <span>Local ASR Engine & GPU</span>
              <span
                className={`chip ${
                  modelStatus?.state === 'ready'
                    ? 'success'
                    : modelStatus?.state === 'missing' || modelStatus?.state === 'error'
                      ? 'danger'
                      : 'warning'
                }`}
              >
                {modelStatus?.state || 'checking'}
              </span>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <div className="setting-label">
                  {modelStatus?.modelName || 'Rumble-2-Flash (GGUF)'}
                </div>
                <div className="setting-desc">
                  Active device: {modelStatus?.activeDeviceName || 'Detecting…'} · Model{' '}
                  {modelStatus?.modelPresent ? 'installed' : 'missing'} · Projector{' '}
                  {modelStatus?.mmprojPresent ? 'installed' : 'missing'} · Runtime{' '}
                  {modelStatus?.runtimePresent ? 'ready' : 'missing'}
                </div>
                {modelStatus?.errorMessage && (
                  <div style={{ marginTop: 6, fontSize: 12, color: 'var(--danger)' }}>
                    {modelStatus.errorMessage}
                  </div>
                )}
                {modelStatus?.state === 'downloading' && modelStatus.downloadProgress && (
                  <div style={{ marginTop: 8, maxWidth: 340 }}>
                    <div className="mini-progress-track">
                      <div
                        className="mini-progress-fill"
                        style={{
                          width: `${Math.min(100, modelStatus.downloadProgress.percent)}%`,
                        }}
                      />
                    </div>
                    <div style={{ marginTop: 4, fontSize: 11.5, color: 'var(--text-muted)' }}>
                      {modelStatus.downloadProgress.file} ·{' '}
                      {Math.round(modelStatus.downloadProgress.percent)}%
                    </div>
                  </div>
                )}
              </div>

              <div className="setting-control" style={{ flexWrap: 'wrap' }}>
                {!modelStatus?.modelPresent || !modelStatus?.mmprojPresent ? (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={modelStatus?.state === 'downloading'}
                    onClick={() => void window.wisperHub?.downloadModel()}
                  >
                    <Download size={13} />
                    <span>Download Model</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void window.wisperHub?.restartModel()}
                >
                  <RefreshCw size={13} />
                  <span>Restart Engine</span>
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={smokeRunning}
                  onClick={() => void handleRunSmokeTest()}
                >
                  <Play size={13} />
                  <span>{smokeRunning ? 'Testing…' : 'Smoke Test'}</span>
                </button>
              </div>
            </div>

            {smokeResult && (
              <div className="setting-row">
                <div className="setting-info">
                  <div className="setting-label">
                    Smoke Test {smokeResult.ok ? 'Passed' : 'Failed'}
                    {smokeResult.latencyMs !== undefined ? ` (${smokeResult.latencyMs}ms)` : ''}
                  </div>
                  <div className="setting-desc">
                    {smokeResult.ok
                      ? smokeResult.text || 'Engine responded cleanly.'
                      : smokeResult.error || 'Unknown error'}
                  </div>
                </div>
              </div>
            )}

            <div className="setting-row">
              <div className="setting-info">
                <div className="setting-label">Inference Backend</div>
                <div className="setting-desc">
                  Use bundled Vulkan llama-server or external crispASR binary.
                </div>
              </div>
              <div className="setting-control" style={{ minWidth: 220 }}>
                <select
                  className="select"
                  value={settings.asrEngine}
                  onChange={(e) =>
                    void onUpdateSettings({
                      asrEngine: e.target.value as 'llama-server' | 'crispasr',
                    })
                  }
                >
                  <option value="llama-server">llama-server (Vulkan GPU)</option>
                  <option value="crispasr">crispasr (External)</option>
                </select>
              </div>
            </div>

            {settings.asrEngine === 'crispasr' && (
              <div className="setting-row">
                <div className="setting-info">
                  <div className="setting-label">Custom crispASR Binary Path</div>
                  <div className="setting-desc">Leave blank to resolve from PATH.</div>
                </div>
                <div className="setting-control" style={{ minWidth: 260 }}>
                  <input
                    type="text"
                    className="input mono"
                    placeholder="/usr/local/bin/crispasr"
                    value={settings.customCrispAsrPath}
                    onChange={(e) =>
                      void onUpdateSettings({ customCrispAsrPath: e.target.value })
                    }
                  />
                </div>
              </div>
            )}

            <div className="setting-row">
              <div className="setting-info">
                <div className="setting-label">GPU Device</div>
                <div className="setting-desc">
                  Prefer discrete GPUs like NVIDIA RTX 4050 for sub-200ms inference.
                </div>
              </div>
              <div className="setting-control" style={{ minWidth: 260 }}>
                <select
                  className="select"
                  value={settings.gpuDeviceId}
                  onChange={(e) => void onUpdateSettings({ gpuDeviceId: e.target.value })}
                >
                  <option value="auto">Auto (Prefer Discrete GPU)</option>
                  {(modelStatus?.availableDevices || []).map((dev) => (
                    <option key={dev.id} value={dev.id}>
                      {dev.description} ({dev.id}){dev.isDiscrete ? ' ★ Discrete' : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </section>

          <section className="settings-group">
            <div className="settings-group-header">
              <span>Rumble-2-Flash Decoding Controls</span>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <div className="setting-label">Format Spoken Numbers as Digits</div>
                <div className="setting-desc">
                  Output numerals (e.g. &ldquo;42&rdquo; instead of &ldquo;forty two&rdquo;).
                </div>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.rumble.digits}
                  onChange={(e) =>
                    void onUpdateSettings({
                      rumble: { ...settings.rumble, digits: e.target.checked },
                    })
                  }
                />
                <span className="switch-track" />
              </label>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <div className="setting-label">Remove Filler Words (&ldquo;um&rdquo;, &ldquo;uh&rdquo;)</div>
                <div className="setting-desc">
                  Sends <span className="kbd">&lt;nofiller&gt;</span> token natively to Rumble-2-Flash.
                </div>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={!settings.rumble.filler}
                  onChange={(e) =>
                    void onUpdateSettings({
                      rumble: { ...settings.rumble, filler: !e.target.checked },
                    })
                  }
                />
                <span className="switch-track" />
              </label>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <div className="setting-label">Verbatim Mode</div>
                <div className="setting-desc">
                  Sends <span className="kbd">&lt;verbatim&gt;</span> to preserve exact phrasing
                  without paraphrasing.
                </div>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.rumble.verbatim}
                  onChange={(e) =>
                    void onUpdateSettings({
                      rumble: { ...settings.rumble, verbatim: e.target.checked },
                    })
                  }
                />
                <span className="switch-track" />
              </label>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <div className="setting-label">Use Dictionary as Context Hints</div>
                <div className="setting-desc">
                  Injects enabled Vocabulary Hints into the Rumble-2-Flash prompt context.
                </div>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.useDictionaryHints}
                  onChange={(e) =>
                    void onUpdateSettings({ useDictionaryHints: e.target.checked })
                  }
                />
                <span className="switch-track" />
              </label>
            </div>
          </section>
        </>
      )}

      {activeTab === 'system' && (
        <>
          <section className="settings-group">
            <div className="settings-group-header">
              <span>Behavior & Appearance</span>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <div className="setting-label">Launch at Login</div>
                <div className="setting-desc">Start Wisper Flow quietly in the background.</div>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.launchAtLogin}
                  onChange={(e) => void onUpdateSettings({ launchAtLogin: e.target.checked })}
                />
                <span className="switch-track" />
              </label>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <div className="setting-label">Hide Flow Bar When Idle</div>
                <div className="setting-desc">
                  Keep the pill hidden until you press your dictation shortcut.
                </div>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.hideFlowBarWhenIdle}
                  onChange={(e) =>
                    void onUpdateSettings({ hideFlowBarWhenIdle: e.target.checked })
                  }
                />
                <span className="switch-track" />
              </label>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <div className="setting-label">Flow Bar Dock Position</div>
                <div className="setting-desc">
                  Left and Right edges orient the Flow Bar vertically.
                </div>
              </div>
              <div className="tabs">
                {(['bottom', 'left', 'right'] as DockPosition[]).map((pos) => (
                  <button
                    key={pos}
                    type="button"
                    className={`tab-btn ${settings.dockPosition === pos ? 'active' : ''}`}
                    onClick={() => void onUpdateSettings({ dockPosition: pos })}
                  >
                    {pos.charAt(0).toUpperCase() + pos.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <div className="setting-label">Mute Other Audio While Dictating</div>
                <div className="setting-desc">
                  Temporarily mutes other apps during active recording.
                </div>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.muteAudioWhileDictating}
                  onChange={(e) =>
                    void onUpdateSettings({
                      muteAudioWhileDictating: e.target.checked,
                      ...(e.target.checked ? { pauseMediaWhileDictating: false } : {}),
                    })
                  }
                />
                <span className="switch-track" />
              </label>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <div className="setting-label">Pause Music &amp; Videos While Dictating</div>
                <div className="setting-desc">
                  Automatically pauses playing songs or videos and resumes them when you finish.
                </div>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.pauseMediaWhileDictating}
                  onChange={(e) =>
                    void onUpdateSettings({
                      pauseMediaWhileDictating: e.target.checked,
                      ...(e.target.checked ? { muteAudioWhileDictating: false } : {}),
                    })
                  }
                />
                <span className="switch-track" />
              </label>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <div className="setting-label">Restore Clipboard After Paste</div>
                <div className="setting-desc">
                  Preserves whatever you had copied before dictating.
                </div>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.restoreClipboardAfterPaste}
                  onChange={(e) =>
                    void onUpdateSettings({ restoreClipboardAfterPaste: e.target.checked })
                  }
                />
                <span className="switch-track" />
              </label>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <div className="setting-label">Hub Theme</div>
                <div className="setting-desc">
                  Omarchy Auto follows your live Omarchy colors.toml palette.
                </div>
              </div>
              <div className="setting-control" style={{ minWidth: 200 }}>
                <select
                  className="select"
                  value={settings.theme}
                  onChange={(e) => void onUpdateSettings({ theme: e.target.value as ThemeMode })}
                >
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                  <option value="system">System</option>
                  <option value="omarchy">Omarchy Auto</option>
                </select>
              </div>
            </div>
          </section>

          <section className="settings-group">
            <div className="settings-group-header">
              <span>Sound Effects & Custom Chimes</span>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.enableSounds}
                  onChange={(e) => void onUpdateSettings({ enableSounds: e.target.checked })}
                />
                <span className="switch-track" />
              </label>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <div className="setting-label">Custom Sound Folder</div>
                <div className="setting-desc mono">
                  {settings.customSoundDir || 'Using built-in Wisper Flow chimes'}
                </div>
              </div>
              <div className="setting-control">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void handleBrowseSoundDir()}
                >
                  <FolderOpen size={13} />
                  <span>Browse</span>
                </button>
                {settings.customSoundDir && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void onUpdateSettings({ customSoundDir: '' })}
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            <div className="sound-grid">
              {ALL_SOUND_SLOTS.map((slot) => {
                const status = soundStatusMap.get(slot);
                const isCustom = status?.source === 'custom';
                return (
                  <div key={slot} className="sound-slot-card">
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>
                        {SOUND_SLOT_LABELS[slot]}
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          marginTop: 3,
                        }}
                      >
                        <span className={`chip ${isCustom ? 'success' : ''}`}>
                          {isCustom ? 'Custom' : 'Built-in'}
                        </span>
                        {status?.fileName && (
                          <span
                            className="mono"
                            style={{
                              fontSize: 11,
                              color: 'var(--text-muted)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {status.fileName}
                          </span>
                        )}
                      </div>
                    </div>

                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={!settings.enableSounds}
                      onClick={() => void window.wisperHub?.playSoundPreview(slot)}
                    >
                      <Volume2 size={13} />
                      <span>Play</span>
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}

      {activeTab === 'cleanup' && (
        <section className="settings-group">
          <div className="settings-group-header">
            <span>Deterministic Text Cleanup (Zero-LLM)</span>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <div className="setting-label">Strip Extra Filler Words</div>
              <div className="setting-desc">
                Removes stray filler hesitations using fast deterministic regex cleanup.
              </div>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.cleanup.stripExtraFillers}
                onChange={(e) =>
                  void onUpdateSettings({
                    cleanup: { ...settings.cleanup, stripExtraFillers: e.target.checked },
                  })
                }
              />
              <span className="switch-track" />
            </label>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <div className="setting-label">Normalize Spacing & Punctuation</div>
              <div className="setting-desc">
                Collapses double spaces and fixes stray spaces before punctuation.
              </div>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.cleanup.normalizeSpacing}
                onChange={(e) =>
                  void onUpdateSettings({
                    cleanup: { ...settings.cleanup, normalizeSpacing: e.target.checked },
                  })
                }
              />
              <span className="switch-track" />
            </label>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <div className="setting-label">Spoken Formatting Commands</div>
              <div className="setting-desc">
                Converts &ldquo;new line&rdquo;, &ldquo;new paragraph&rdquo;, and &ldquo;bullet
                point&rdquo; into actual line breaks and bullets.
              </div>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.cleanup.spokenFormatting}
                onChange={(e) =>
                  void onUpdateSettings({
                    cleanup: { ...settings.cleanup, spokenFormatting: e.target.checked },
                  })
                }
              />
              <span className="switch-track" />
            </label>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <div className="setting-label">Force All Lowercase Globally</div>
              <div className="setting-desc">Converts every final transcript to lowercase.</div>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.cleanup.allLowercaseGlobal}
                onChange={(e) =>
                  void onUpdateSettings({
                    cleanup: { ...settings.cleanup, allLowercaseGlobal: e.target.checked },
                  })
                }
              />
              <span className="switch-track" />
            </label>
          </div>

          <div className="setting-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <div className="setting-info">
              <div className="setting-label">Force Lowercase in Specific Apps</div>
              <div className="setting-desc">
                Add process names (e.g. <span className="mono">discord.exe</span>,{' '}
                <span className="mono">slack</span>, <span className="mono">kitty</span>).
              </div>
            </div>

            <form className="toolbar" onSubmit={handleAddLowercaseApp}>
              <input
                type="text"
                className="input mono"
                style={{ flex: 1 }}
                placeholder="Process name…"
                value={lowercaseAppInput}
                onChange={(e) => setLowercaseAppInput(e.target.value)}
              />
              <button
                type="submit"
                className="btn btn-sm"
                disabled={!lowercaseAppInput.trim()}
              >
                <Plus size={13} />
                <span>Add App</span>
              </button>
            </form>

            {settings.cleanup.allLowercaseApps.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {settings.cleanup.allLowercaseApps.map((app) => (
                  <span key={app} className="chip mono">
                    <span>{app}</span>
                    <button
                      type="button"
                      className="icon-btn"
                      style={{ width: 16, height: 16 }}
                      onClick={() => handleRemoveLowercaseApp(app)}
                      aria-label={`Remove ${app}`}
                    >
                      <Trash2 size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {activeTab === 'omarchy' && (
        <>
          <section className="settings-group">
            <div className="settings-group-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Wrench size={14} />
                <span>Omarchy & Hyprland Integration</span>
              </div>
              <span className={`chip ${omarchyEnv?.isOmarchy ? 'success' : ''}`}>
                {envBadgeText}
              </span>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <div className="setting-label">
                  {isWindowsPreview
                    ? 'Windows Preview Mode'
                    : omarchyEnv?.isOmarchy
                      ? 'Omarchy Desktop Detected'
                      : 'Linux Wayland / X11 Environment'}
                </div>
                <div className="setting-desc mono">
                  {omarchyEnv
                    ? `${omarchyEnv.hyprDir} · Bindings: ${
                        omarchyEnv.bindingsInstalled ? 'Installed' : 'Not installed'
                      } · Window Rules: ${
                        omarchyEnv.windowRulesInstalled ? 'Installed' : 'Not installed'
                      }`
                    : 'Inspecting system environment…'}
                </div>
              </div>

              <div className="setting-control" style={{ flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={omarchyBusy || isWindowsPreview}
                  onClick={async () => {
                    setOmarchyBusy(true);
                    try {
                      const next = await window.wisperHub?.applyOmarchySetup();
                      if (next) onOmarchyUpdated(next);
                    } finally {
                      setOmarchyBusy(false);
                    }
                  }}
                >
                  Apply Omarchy Setup
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={omarchyBusy || isWindowsPreview}
                  onClick={async () => {
                    setOmarchyBusy(true);
                    try {
                      const next = await window.wisperHub?.removeOmarchySetup();
                      if (next) onOmarchyUpdated(next);
                    } finally {
                      setOmarchyBusy(false);
                    }
                  }}
                >
                  Remove Setup
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title="Refresh detection"
                  disabled={omarchyBusy}
                  onClick={async () => {
                    setOmarchyBusy(true);
                    try {
                      const next = await window.wisperHub?.refreshOmarchy();
                      if (next) onOmarchyUpdated(next);
                    } finally {
                      setOmarchyBusy(false);
                    }
                  }}
                >
                  <RefreshCw size={14} />
                </button>
              </div>
            </div>

            {omarchyEnv && (
              <div className="setting-row" style={{ flexWrap: 'wrap' }}>
                <div className="setting-info">
                  <div className="setting-label">Detected Wayland & Audio Tools</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                    {(
                      [
                        ['hyprctl', omarchyEnv.availableTools.hyprctl],
                        ['wl-copy', omarchyEnv.availableTools.wlCopy],
                        ['wtype', omarchyEnv.availableTools.wtype],
                        ['ydotool', omarchyEnv.availableTools.ydotool],
                        ['xdotool', omarchyEnv.availableTools.xdotool],
                        ['xclip', omarchyEnv.availableTools.xclip],
                        ['pactl', omarchyEnv.availableTools.pactl],
                        ['pw-record', omarchyEnv.availableTools.pwRecord],
                      ] as Array<[string, boolean]>
                    ).map(([tool, present]) => (
                      <span key={tool} className={`chip mono ${present ? 'success' : ''}`}>
                        {tool}: {present ? 'ok' : 'missing'}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div className="setting-row">
              <div className="setting-info">
                <div className="setting-label">Linux Paste Backend</div>
                <div className="setting-desc">
                  Choose how transcribed text is injected into the focused Linux window.
                </div>
              </div>
              <div className="setting-control" style={{ minWidth: 200 }}>
                <select
                  className="select"
                  value={settings.linuxPasteBackend}
                  onChange={(e) =>
                    void onUpdateSettings({
                      linuxPasteBackend: e.target.value as LinuxPasteBackend,
                    })
                  }
                >
                  <option value="auto">Auto (Best available)</option>
                  <option value="hyprctl">hyprctl dispatch sendshortcut</option>
                  <option value="wtype">wtype (Wayland)</option>
                  <option value="ydotool">ydotool (Kernel uinput)</option>
                  <option value="xdotool">xdotool (X11)</option>
                </select>
              </div>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <div className="setting-label">Terminal Paste Shortcut</div>
                <div className="setting-desc">
                  Shortcut dispatched when pasting into Ghostty, Kitty, Alacritty, Foot, or Windows
                  Terminal.
                </div>
              </div>
              <div className="tabs">
                <button
                  type="button"
                  className={`tab-btn ${settings.terminalPasteMode === 'ctrl-shift-v' ? 'active' : ''}`}
                  onClick={() => void onUpdateSettings({ terminalPasteMode: 'ctrl-shift-v' })}
                >
                  Ctrl+Shift+V
                </button>
                <button
                  type="button"
                  className={`tab-btn ${settings.terminalPasteMode === 'shift-insert' ? 'active' : ''}`}
                  onClick={() => void onUpdateSettings({ terminalPasteMode: 'shift-insert' })}
                >
                  Shift+Insert
                </button>
              </div>
            </div>
          </section>

          <section className="settings-group">
            <div className="settings-group-header">
              <span>Live Omarchy colors.toml Palette</span>
              {omarchyEnv?.palette?.sourcePath && (
                <span className="chip mono">{omarchyEnv.palette.sourcePath}</span>
              )}
            </div>

            {paletteSwatches.length > 0 ? (
              <div className="swatch-grid">
                {paletteSwatches.map(([name, hex]) => (
                  <div key={name} className="swatch-item">
                    <span className="swatch-dot" style={{ background: hex }} />
                    <span className="mono">{name}</span>
                    <span className="mono" style={{ color: 'var(--text-muted)' }}>
                      {hex}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ padding: '14px 16px', fontSize: 13, color: 'var(--text-muted)' }}>
                No active Omarchy <span className="mono">colors.toml</span> detected on this
                machine.
              </div>
            )}
          </section>

          {omarchyEnv && (
            <section className="settings-group">
              <div className="settings-group-header">
                <span>Generated Hyprland Rules Preview</span>
              </div>

              <div className="setting-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                <div className="toolbar" style={{ justifyContent: 'space-between' }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setShowLuaSnippet((v) => !v)}
                  >
                    {showLuaSnippet ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <span>Omarchy v4 Lua Snippet</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() =>
                      void handleCopySnippet('lua', omarchyEnv.generatedLuaSnippet)
                    }
                  >
                    {copiedSnippet === 'lua' ? <Check size={13} /> : <Copy size={13} />}
                    <span>{copiedSnippet === 'lua' ? 'Copied' : 'Copy Lua'}</span>
                  </button>
                </div>
                {showLuaSnippet && (
                  <pre className="code-block">{omarchyEnv.generatedLuaSnippet}</pre>
                )}
              </div>

              <div className="setting-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                <div className="toolbar" style={{ justifyContent: 'space-between' }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setShowConfSnippet((v) => !v)}
                  >
                    {showConfSnippet ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <span>Hyprland / Omarchy v3 Conf Snippet</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() =>
                      void handleCopySnippet('conf', omarchyEnv.generatedConfSnippet)
                    }
                  >
                    {copiedSnippet === 'conf' ? <Check size={13} /> : <Copy size={13} />}
                    <span>{copiedSnippet === 'conf' ? 'Copied' : 'Copy Conf'}</span>
                  </button>
                </div>
                {showConfSnippet && (
                  <pre className="code-block">{omarchyEnv.generatedConfSnippet}</pre>
                )}
              </div>
            </section>
          )}
        </>
      )}
    </>
  );
};
