import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Mic, Square, X } from 'lucide-react';
import type { HudPayload } from '@shared/types';
import { audioPlayer } from '../shared/audioPlayer';
import {
  disposeWarmMic,
  enumerateAudioInputs,
  isWarmMicHealthy,
  startMicCapture,
  warmMic,
  type MicCaptureSession,
} from './micCapture';
import './hud.css';

const DEFAULT_BARS = new Array<number>(10).fill(0.08);

const INITIAL_HUD: HudPayload = {
  state: 'resting',
  dockPosition: 'bottom',
  pushToTalkLabel: 'Ctrl+Win',
  handsFreeLabel: 'Ctrl+Win+Space',
};

export const HudApp: React.FC = () => {
  const [payload, setPayload] = useState<HudPayload>(INITIAL_HUD);
  const [liveBars, setLiveBars] = useState<number[]>(DEFAULT_BARS);
  const [dismissedToastKey, setDismissedToastKey] = useState<string | null>(null);
  const [localErrorToast, setLocalErrorToast] = useState<string | null>(null);

  const captureRef = useRef<MicCaptureSession | null>(null);
  const startingCaptureRef = useRef<Promise<MicCaptureSession | null> | null>(null);
  const abortedSessionIdRef = useRef<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const microphoneDeviceIdRef = useRef<string>('default');
  const pendingDeviceRefreshRef = useRef<boolean>(false);
  const hoverTimerRef = useRef<number | null>(null);
  const hoveredRef = useRef(false);

  const syncAudioDevices = useCallback(async () => {
    const devices = await enumerateAudioInputs();
    try {
      await window.wisperHud?.setAudioDevices(devices);
    } catch {
      // Ignore if main isn't ready
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    const refreshWarmMic = (forceRefresh = false) => {
      if (!mounted) return;
      if (activeSessionIdRef.current || startingCaptureRef.current) {
        pendingDeviceRefreshRef.current = true;
        return;
      }
      pendingDeviceRefreshRef.current = false;
      void warmMic(microphoneDeviceIdRef.current, { forceRefresh }).catch(() => {});
    };

    void window.wisperHud
      ?.getState()
      .then((initial) => {
        if (!mounted) return;
        if (initial) {
          setPayload(initial);
          if (initial.microphoneDeviceId) {
            microphoneDeviceIdRef.current = initial.microphoneDeviceId;
          }
        }
        refreshWarmMic();
      })
      .catch(() => {
        refreshWarmMic();
      });

    void syncAudioDevices();

    const handleDeviceChange = () => {
      void syncAudioDevices();
      const currentDeviceId = microphoneDeviceIdRef.current;
      if (currentDeviceId === 'default' || !isWarmMicHealthy(currentDeviceId)) {
        refreshWarmMic(currentDeviceId === 'default');
      }
    };
    navigator.mediaDevices?.addEventListener?.('devicechange', handleDeviceChange);

    const unsubState = window.wisperHud?.onHudState((next) => {
      if (!mounted) return;
      setPayload(next);
      if (next.microphoneDeviceId && next.microphoneDeviceId !== microphoneDeviceIdRef.current) {
        microphoneDeviceIdRef.current = next.microphoneDeviceId;
        refreshWarmMic();
      }
      if (next.toastMessage) {
        setDismissedToastKey(null);
      }
      if (next.state !== 'error') {
        setLocalErrorToast(null);
      }
    });

    const unsubSound = window.wisperHud?.onPlaySound(({ slot, dataUrl }) => {
      void audioPlayer.play(slot, dataUrl);
    });

    const unsubCmd = window.wisperHud?.onRecordCmd(async (cmd) => {
      if (cmd.action === 'start') {
        if (captureRef.current) {
          await captureRef.current.cancel();
          captureRef.current = null;
        }
        abortedSessionIdRef.current = null;
        activeSessionIdRef.current = cmd.sessionId;
        setLocalErrorToast(null);
        setLiveBars(DEFAULT_BARS);

        let startTask: Promise<MicCaptureSession | null> | null = null;
        startTask = (async (): Promise<MicCaptureSession | null> => {
          try {
            const session = await startMicCapture({
              deviceId: cmd.deviceId,
              whisperMode: cmd.whisperMode,
              onLevels: (bars) => {
                if (mounted) setLiveBars(bars);
              },
            });
            if (abortedSessionIdRef.current === cmd.sessionId || activeSessionIdRef.current !== cmd.sessionId) {
              await session.cancel();
              return null;
            }
            captureRef.current = session;
            return session;
          } catch (err) {
            const message =
              err instanceof Error ? err.message : 'Microphone access failed';
            if (abortedSessionIdRef.current !== cmd.sessionId) {
              setLocalErrorToast(message);
              activeSessionIdRef.current = null;
              try {
                await window.wisperHud?.submitAudio({
                  sessionId: cmd.sessionId,
                  wavBuffer: new Uint8Array(0),
                  durationMs: 0,
                  speechDurationMs: 0,
                  peakLevel: 0,
                  error: message,
                });
              } catch {}
            }
            return null;
          } finally {
            if (startingCaptureRef.current === startTask) {
              startingCaptureRef.current = null;
            }
          }
        })();

        startingCaptureRef.current = startTask;
        await startTask;
      } else if (cmd.action === 'stop') {
        if (!captureRef.current && startingCaptureRef.current) {
          await startingCaptureRef.current;
        }
        const session = captureRef.current;
        const sid = activeSessionIdRef.current || cmd.sessionId;
        captureRef.current = null;
        activeSessionIdRef.current = null;
        setLiveBars(DEFAULT_BARS);

        if (!session) {
          try {
            await window.wisperHud?.submitAudio({
              sessionId: sid,
              wavBuffer: new Uint8Array(0),
              durationMs: 0,
              speechDurationMs: 0,
              peakLevel: 0,
              error: 'No active microphone capture',
            });
          } catch {}
          return;
        }

        try {
          const res = await session.stop();
          const deadMicError =
            res.peakLevel === 0 ? 'Microphone muted or no audio signal detected' : undefined;
          if (deadMicError) {
            setLocalErrorToast(deadMicError);
          }
          await window.wisperHud?.submitAudio({
            sessionId: sid,
            wavBuffer: res.wavBuffer,
            durationMs: res.durationMs,
            speechDurationMs: res.speechDurationMs,
            peakLevel: res.peakLevel,
            deviceLabel: res.deviceLabel,
            error: deadMicError,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to capture audio';
          try {
            await window.wisperHud?.submitAudio({
              sessionId: sid,
              wavBuffer: new Uint8Array(0),
              durationMs: 0,
              speechDurationMs: 0,
              peakLevel: 0,
              error: message,
            });
          } catch {}
        } finally {
          if (pendingDeviceRefreshRef.current) {
            refreshWarmMic(microphoneDeviceIdRef.current === 'default');
          }
        }
      } else if (cmd.action === 'cancel') {
        abortedSessionIdRef.current = cmd.sessionId;
        const session = captureRef.current;
        captureRef.current = null;
        activeSessionIdRef.current = null;
        setLiveBars(DEFAULT_BARS);
        if (session) {
          await session.cancel();
        }
        if (pendingDeviceRefreshRef.current) {
          refreshWarmMic(microphoneDeviceIdRef.current === 'default');
        }
      }
    });

    return () => {
      mounted = false;
      navigator.mediaDevices?.removeEventListener?.('devicechange', handleDeviceChange);
      unsubState?.();
      unsubSound?.();
      unsubCmd?.();
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
      }
      if (captureRef.current) {
        void captureRef.current.cancel();
        captureRef.current = null;
      }
      void disposeWarmMic();
    };
  }, [syncAudioDevices]);

  const handlePointerEnter = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    if (!hoveredRef.current) {
      hoveredRef.current = true;
      void window.wisperHud?.mouseEnter().catch(() => {});
    }
  }, []);

  const handlePointerLeave = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
    }
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = null;
      if (hoveredRef.current) {
        hoveredRef.current = false;
        void window.wisperHud?.mouseLeave().catch(() => {});
      }
    }, 35);
  }, []);

  const handlePillClick = useCallback(() => {
    if (payload.state === 'resting' || payload.state === 'ready' || payload.state === 'error') {
      void window.wisperHud?.sendAction({ type: 'click-toggle' }).catch(() => {});
    }
  }, [payload.state]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    void window.wisperHud?.openContextMenu().catch(() => {});
  }, []);

  const isVertical = payload.dockPosition === 'left' || payload.dockPosition === 'right';
  const isRecording = payload.state === 'active_ptt' || payload.state === 'active_popo';

  const barsToRender = useMemo(() => {
    if (payload.audioLevels && payload.audioLevels.length === 10 && !isRecording) {
      return payload.audioLevels;
    }
    return liveBars;
  }, [isRecording, liveBars, payload.audioLevels]);

  const activeToastMessage = localErrorToast || payload.toastMessage || '';
  const toastKey = `${payload.state}:${activeToastMessage}`;
  const showToast = Boolean(activeToastMessage) && dismissedToastKey !== toastKey;
  const showReadyTooltip = payload.state === 'ready' && !showToast;

  const pillAccentStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (!payload.palette?.accent) return undefined;
    if (payload.state === 'active_ptt' || payload.state === 'active_popo') {
      return { borderColor: payload.palette.accent };
    }
    return undefined;
  }, [payload.palette?.accent, payload.state]);

  return (
    <div className={`hud-stage dock-${payload.dockPosition}`}>
      <div className="hud-anchor">
        {showReadyTooltip && (
          <div
            className="hud-popover"
            onMouseEnter={handlePointerEnter}
            onMouseLeave={handlePointerLeave}
          >
            <span>Click to dictate · {payload.pushToTalkLabel}</span>
          </div>
        )}

        {showToast && (
          <div
            className={`hud-popover toast-${payload.toastKind || (payload.state === 'error' ? 'error' : 'info')}`}
            onMouseEnter={handlePointerEnter}
            onMouseLeave={handlePointerLeave}
          >
            <span>{activeToastMessage}</span>
            <button
              type="button"
              className="hud-toast-dismiss"
              aria-label="Dismiss"
              onClick={(e) => {
                e.stopPropagation();
                setDismissedToastKey(toastKey);
                setLocalErrorToast(null);
              }}
            >
              <X size={10} />
            </button>
          </div>
        )}

        <div
          className={`hud-pill state-${payload.state}`}
          style={pillAccentStyle}
          onMouseEnter={handlePointerEnter}
          onMouseLeave={handlePointerLeave}
          onClick={handlePillClick}
          onContextMenu={handleContextMenu}
          role="button"
          tabIndex={-1}
          aria-label="Wisper Flow HUD"
        >
          {payload.state === 'ready' && (
            <span className="hud-mic-icon">
              <Mic size={14} strokeWidth={2.2} />
            </span>
          )}

          {payload.state === 'active_ptt' && (
            <div className="hud-bars" aria-hidden="true">
              {barsToRender.map((lvl, idx) => {
                const px = Math.round(2 + Math.max(0, Math.min(1, lvl)) * 12);
                return (
                  <span
                    key={idx}
                    className="hud-bar"
                    style={isVertical ? { width: `${px}px`, height: '2px' } : { height: `${px}px` }}
                  />
                );
              })}
            </div>
          )}

          {payload.state === 'active_popo' && (
            <>
              <button
                type="button"
                className="hud-ctl-btn cancel"
                title="Cancel dictation"
                aria-label="Cancel dictation"
                onClick={(e) => {
                  e.stopPropagation();
                  void window.wisperHud?.sendAction({ type: 'cancel' }).catch(() => {});
                }}
              >
                <X size={11} strokeWidth={2.5} />
              </button>

              <div className="hud-bars" aria-hidden="true">
                {barsToRender.map((lvl, idx) => {
                  const px = Math.round(2 + Math.max(0, Math.min(1, lvl)) * 11);
                  return (
                    <span
                      key={idx}
                      className="hud-bar"
                      style={
                        isVertical ? { width: `${px}px`, height: '2px' } : { height: `${px}px` }
                      }
                    />
                  );
                })}
              </div>

              <button
                type="button"
                className="hud-ctl-btn stop"
                title="Stop and transcribe"
                aria-label="Stop and transcribe"
                onClick={(e) => {
                  e.stopPropagation();
                  void window.wisperHud?.sendAction({ type: 'stop' }).catch(() => {});
                }}
              >
                <Square size={9} fill="currentColor" strokeWidth={0} />
              </button>
            </>
          )}

          {payload.state === 'processing' && (
            <div className="hud-dots" aria-label="Transcribing">
              <span className="hud-dot" />
              <span className="hud-dot" />
              <span className="hud-dot" />
            </div>
          )}

          {payload.state === 'error' && (
            <span className="hud-error-badge">
              <AlertCircle size={13} strokeWidth={2.2} />
              {!isVertical && <span>Error</span>}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
