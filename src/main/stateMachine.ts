import crypto from 'node:crypto';
// @ts-ignore Node --experimental-strip-types requires explicit .ts extension
import { DICTATION_DEBOUNCE_MS, DOUBLE_TAP_WINDOW_MS, MAX_RECORDING_STOP_MS, MAX_RECORDING_WARN_MS } from '../shared/defaults.ts';
// @ts-ignore Node --experimental-strip-types requires explicit .ts extension
import { runTextPipeline } from './pipeline/textPipeline.ts';
// @ts-ignore Node --experimental-strip-types requires explicit .ts extension
import { scheduleCorrectionWatch } from './pipeline/correctionWatcher.ts';
import type {
  AppSettings,
  DictionaryEntry,
  HistoryEntry,
  HudPayload,
  HudVisualState,
  MicProfile,
  SoundSlot,
} from '../shared/types';
import type { AsrBackend } from './asr/types';
import type { ForegroundAppInfo, PlatformBridge } from './platform/types';
import type { CorpusStore } from './storage/corpusStore';
import type { AppDatabase } from './storage/db';

export interface StateMachineDeps {
  getSettings: () => AppSettings;
  platform: PlatformBridge;
  asr: AsrBackend;
  db: AppDatabase;
  corpusStore?: Pick<CorpusStore, 'saveClip'>;
  sendHudState: (payload: HudPayload) => void;
  sendRecordCommand: (cmd: {
    action: 'start' | 'stop' | 'cancel';
    sessionId: string;
    deviceId: string;
    whisperMode: boolean;
    micProfile?: MicProfile;
  }) => void;
  playSound: (slot: SoundSlot) => void;
  onHistoryAdded: (entry: HistoryEntry) => void;
  onSuggestionsUpdated?: () => void;
  getExtraExcludePids?: () => number[];
}

export interface AudioSubmitPayload {
  sessionId: string;
  wavBuffer: Buffer;
  opusBuffer?: Buffer;
  speechDurationMs: number;
  totalDurationMs: number;
  isSilent?: boolean;
  error?: string;
}

const ERROR_RESET_DELAY_MS = 3500;
const FALLBACK_APP: ForegroundAppInfo = {
  processName: '',
  title: '',
  isTerminal: false,
};

/**
 * Builds deduplicated ASR vocabulary hints from enabled dictionary entries,
 * preferring target spellings (`replacement`) over misheard `phrase` triggers.
 */
export function buildDictionaryContextHints(
  dictionary: ReadonlyArray<Pick<DictionaryEntry, 'enabled' | 'phrase' | 'replacement'>>
): string[] {
  const seen = new Set<string>();
  const hints: string[] = [];

  for (const entry of dictionary) {
    if (!entry.enabled) continue;
    const hint = entry.replacement?.trim() || entry.phrase.trim();
    if (!hint) continue;

    const normalized = hint.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    hints.push(hint);
  }

  return hints;
}

export class DictationStateMachine {
  private readonly deps: StateMachineDeps;
  private state: HudVisualState;
  private isHovering = false;
  private sessionId: string | null = null;
  private recordingStartedAt: number | null = null;
  private lastTapAt = 0;
  private shortTapStreak = 0;
  private activeForegroundApp: ForegroundAppInfo | null = null;
  private foregroundAppPromise: Promise<ForegroundAppInfo> | null = null;
  private warnTimer: ReturnType<typeof setTimeout> | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private errorResetTimer: ReturnType<typeof setTimeout> | null = null;
  private suggestionToastTimer: ReturnType<typeof setTimeout> | null = null;
  private audioMutedByUs = false;
  private mediaPausedByUs = false;
  private muteChain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(deps: StateMachineDeps) {
    this.deps = deps;
    this.state = this.computeIdleState();
  }

  getState(): HudVisualState {
    return this.state;
  }

  getCurrentPayload(): HudPayload {
    const settings = this.deps.getSettings();
    return {
      state: this.state,
      dockPosition: settings.dockPosition,
      pushToTalkLabel: settings.shortcuts.pushToTalk,
      handsFreeLabel: settings.shortcuts.handsFree,
      microphoneDeviceId: settings.microphoneDeviceId,
      micProfile: settings.micProfile,
      recordingStartedAt: this.recordingStartedAt ?? undefined,
    };
  }

  private computeIdleState(): HudVisualState {
    const settings = this.deps.getSettings();
    if (this.isHovering && !settings.hideFlowBarWhenIdle) {
      return 'ready';
    }
    return settings.hideFlowBarWhenIdle ? 'hidden' : 'resting';
  }

  private isIdleState(state: HudVisualState = this.state): boolean {
    return state === 'hidden' || state === 'resting' || state === 'ready';
  }

  private clearSessionTimers(): void {
    if (this.warnTimer) {
      clearTimeout(this.warnTimer);
      this.warnTimer = null;
    }
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
  }

  private clearErrorResetTimer(): void {
    if (this.errorResetTimer) {
      clearTimeout(this.errorResetTimer);
      this.errorResetTimer = null;
    }
  }

  private clearSuggestionToastTimer(): void {
    if (this.suggestionToastTimer) {
      clearTimeout(this.suggestionToastTimer);
      this.suggestionToastTimer = null;
    }
  }

  private emitRecordCommand(
    action: 'start' | 'stop' | 'cancel',
    sessionId: string,
    settings: AppSettings
  ): void {
    this.deps.sendRecordCommand({
      action,
      sessionId,
      deviceId: settings.microphoneDeviceId,
      whisperMode: settings.micProfile === 'quiet' || settings.whisperModeBoost,
      micProfile: settings.micProfile,
    });
  }

  private emitHudState(toast?: { message: string; kind: 'info' | 'warning' | 'error' }): void {
    if (this.disposed) return;
    const payload = this.getCurrentPayload();
    if (toast) {
      payload.toastMessage = toast.message;
      payload.toastKind = toast.kind;
    }
    this.deps.sendHudState(payload);
  }

  private muteAudioIfNeeded(settings: AppSettings): Promise<void> {
    const excludePids = [
      process.pid,
      ...this.deps.platform.getHelperPids(),
      ...(this.deps.getExtraExcludePids?.() ?? []),
    ];

    if (settings.pauseMediaWhileDictating && !this.mediaPausedByUs && this.deps.platform.pauseMedia) {
      this.mediaPausedByUs = true;
      this.muteChain = this.muteChain
        .then(() => this.deps.platform.pauseMedia?.(excludePids))
        .catch(() => {});
      return this.muteChain;
    }

    if (!settings.muteAudioWhileDictating || this.audioMutedByUs) {
      return this.muteChain;
    }
    this.audioMutedByUs = true;
    this.muteChain = this.muteChain
      .then(() => this.deps.platform.muteOtherAudio(excludePids))
      .catch(() => {});
    return this.muteChain;
  }

  private unmuteAudioSafely(): Promise<void> {
    if (this.mediaPausedByUs) {
      this.mediaPausedByUs = false;
      this.muteChain = this.muteChain
        .then(() => this.deps.platform.resumeMedia?.())
        .catch(() => {});
    }
    if (!this.audioMutedByUs) {
      return this.muteChain;
    }
    this.audioMutedByUs = false;
    this.muteChain = this.muteChain
      .then(() => this.deps.platform.unmuteOtherAudio())
      .catch(() => {});
    return this.muteChain;
  }

  private async startRecordingSession(mode: 'active_ptt' | 'active_popo'): Promise<void> {
    this.clearErrorResetTimer();
    this.clearSuggestionToastTimer();
    this.clearSessionTimers();

    const settings = this.deps.getSettings();
    const sessionId = crypto.randomUUID();
    const startedAt = Date.now();

    this.state = mode;
    this.sessionId = sessionId;
    this.recordingStartedAt = startedAt;
    this.activeForegroundApp = null;

    this.foregroundAppPromise = this.deps.platform
      .getForegroundApp()
      .then((app) => {
        if (this.sessionId === sessionId) {
          this.activeForegroundApp = app;
        }
        return app;
      })
      .catch(() => FALLBACK_APP);

    this.deps.playSound(mode === 'active_popo' ? 'popoLock' : 'start');
    this.emitRecordCommand('start', sessionId, settings);
    this.emitHudState();

    this.warnTimer = setTimeout(() => {
      if (this.disposed || this.sessionId !== sessionId) return;
      if (this.state !== 'active_ptt' && this.state !== 'active_popo') return;
      this.deps.playSound('alert');
      this.emitHudState({
        message: '1 minute remaining before automatic stop',
        kind: 'warning',
      });
    }, MAX_RECORDING_WARN_MS);

    this.stopTimer = setTimeout(() => {
      if (this.disposed || this.sessionId !== sessionId) return;
      if (this.state !== 'active_ptt' && this.state !== 'active_popo') return;
      void this.stopRecordingForProcessing();
    }, MAX_RECORDING_STOP_MS);

    await Promise.all([this.muteAudioIfNeeded(settings), this.foregroundAppPromise]);
  }

  private async stopRecordingForProcessing(): Promise<void> {
    if (this.disposed || !this.sessionId) return;
    if (this.state !== 'active_ptt' && this.state !== 'active_popo') return;

    this.clearSessionTimers();
    const settings = this.deps.getSettings();
    const activeSessionId = this.sessionId;

    this.state = 'processing';
    this.deps.playSound('stop');
    this.emitRecordCommand('stop', activeSessionId, settings);
    this.emitHudState();

    await this.unmuteAudioSafely();
  }

  private enterErrorState(message: string): void {
    this.clearSessionTimers();
    this.clearErrorResetTimer();
    this.sessionId = null;
    this.recordingStartedAt = null;
    this.state = 'error';
    this.deps.playSound('error');
    this.emitHudState({ message, kind: 'error' });

    this.errorResetTimer = setTimeout(() => {
      this.errorResetTimer = null;
      if (this.disposed || this.state !== 'error') return;
      this.state = this.computeIdleState();
      this.emitHudState();
    }, ERROR_RESET_DELAY_MS);
  }

  async handlePttDown(): Promise<void> {
    if (this.disposed) return;
    if (this.state === 'active_ptt' || this.state === 'processing') return;

    if (this.state === 'active_popo') {
      await this.stopRecordingForProcessing();
      return;
    }

    const now = Date.now();
    const isDoubleTap =
      this.lastTapAt > 0 && now - this.lastTapAt <= DOUBLE_TAP_WINDOW_MS;

    if (isDoubleTap) {
      this.lastTapAt = 0;
      this.shortTapStreak = 0;
      await this.startRecordingSession('active_popo');
      return;
    }

    await this.startRecordingSession('active_ptt');
  }

  async handlePttUp(): Promise<void> {
    if (this.disposed || this.state !== 'active_ptt') return;

    const now = Date.now();
    const elapsed = now - (this.recordingStartedAt ?? now);

    if (elapsed < DICTATION_DEBOUNCE_MS) {
      this.clearSessionTimers();
      const cancelledSessionId = this.sessionId;
      const settings = this.deps.getSettings();

      this.lastTapAt = now;
      this.shortTapStreak += 1;
      this.sessionId = null;
      this.recordingStartedAt = null;
      this.activeForegroundApp = null;
      this.state = this.computeIdleState();

      if (cancelledSessionId) {
        this.emitRecordCommand('cancel', cancelledSessionId, settings);
      }

      if (this.shortTapStreak >= 2) {
        this.shortTapStreak = 0;
        this.emitHudState({
          message: 'Hold key to dictate, or double-tap for hands-free',
          kind: 'info',
        });
      } else {
        this.emitHudState();
      }

      await this.unmuteAudioSafely();
      return;
    }

    this.lastTapAt = 0;
    this.shortTapStreak = 0;
    await this.stopRecordingForProcessing();
  }

  async handleDirectPttStart(): Promise<void> {
    await this.handlePttDown();
  }

  async handleDirectPttStop(): Promise<void> {
    if (this.state !== 'active_ptt') return;
    await this.handlePttUp();
  }

  async handleHandsFreeToggle(): Promise<void> {
    if (this.disposed || this.state === 'processing') return;

    if (this.state === 'active_ptt') {
      const elapsed = Date.now() - (this.recordingStartedAt ?? Date.now());
      if (elapsed < DICTATION_DEBOUNCE_MS) {
        // Ctrl+Win fired just before Space in Ctrl+Win+Space: promote to Hands-Free instead of stopping
        this.state = 'active_popo';
        this.lastTapAt = 0;
        this.shortTapStreak = 0;
        this.deps.playSound('popoLock');
        this.emitHudState();
        return;
      }
      this.lastTapAt = 0;
      this.shortTapStreak = 0;
      await this.stopRecordingForProcessing();
      return;
    }

    if (this.state === 'active_popo') {
      this.lastTapAt = 0;
      this.shortTapStreak = 0;
      await this.stopRecordingForProcessing();
      return;
    }

    this.lastTapAt = 0;
    this.shortTapStreak = 0;
    await this.startRecordingSession('active_popo');
  }

  async handlePttOtherKey(): Promise<void> {
    if (this.disposed || this.state !== 'active_ptt') return;

    this.clearSessionTimers();
    const cancelledSessionId = this.sessionId;
    const settings = this.deps.getSettings();

    this.lastTapAt = 0;
    this.shortTapStreak = 0;
    this.sessionId = null;
    this.recordingStartedAt = null;
    this.activeForegroundApp = null;
    this.state = this.computeIdleState();

    if (cancelledSessionId) {
      this.emitRecordCommand('cancel', cancelledSessionId, settings);
    }

    this.emitHudState();
    await this.unmuteAudioSafely();
  }

  async handleCancel(): Promise<void> {
    if (this.disposed) return;
    if (
      this.state !== 'active_ptt' &&
      this.state !== 'active_popo' &&
      this.state !== 'processing'
    ) {
      return;
    }

    const wasRecording = this.state === 'active_ptt' || this.state === 'active_popo';
    const cancelledSessionId = this.sessionId;
    const settings = this.deps.getSettings();

    this.clearSessionTimers();
    this.clearErrorResetTimer();
    this.lastTapAt = 0;
    this.shortTapStreak = 0;
    this.sessionId = null;
    this.recordingStartedAt = null;
    this.activeForegroundApp = null;
    this.state = this.computeIdleState();

    if (wasRecording && cancelledSessionId) {
      this.emitRecordCommand('cancel', cancelledSessionId, settings);
    }

    this.emitHudState();
    await this.unmuteAudioSafely();
  }

  async handleAudioSubmitted(payload: AudioSubmitPayload): Promise<void> {
    if (this.disposed || !this.sessionId || payload.sessionId !== this.sessionId) {
      return;
    }

    const activeSessionId = this.sessionId;
    this.clearSessionTimers();
    this.shortTapStreak = 0;
    this.lastTapAt = 0;

    await this.unmuteAudioSafely();
    if (this.disposed || this.sessionId !== activeSessionId) return;

    if (payload.error || payload.isSilent || payload.wavBuffer.length === 0) {
      const msg = payload.error?.trim() || 'No audio detected — check your microphone';
      this.enterErrorState(msg);
      return;
    }

    this.state = 'processing';
    this.emitHudState();

    const e2eStart = Date.now();
    const settings = this.deps.getSettings();
    const capturedApp =
      this.activeForegroundApp ??
      (this.foregroundAppPromise ? await this.foregroundAppPromise : null) ??
      FALLBACK_APP;

    if (this.disposed || this.sessionId !== activeSessionId) return;

    const dictionary = this.deps.db.listDictionary();
    const contextHints = settings.useDictionaryHints
      ? buildDictionaryContextHints(dictionary)
      : undefined;

    let rawText = '';
    let detectedLanguage: string | undefined;
    let asrUsage: { promptTokens: number; completionTokens: number; totalTokens: number; estimated?: boolean } | undefined;
    try {
      const asrResult = await this.deps.asr.transcribe({
        wavBuffer: payload.wavBuffer,
        language: settings.language,
        rumble: settings.rumble,
        contextHints,
        micProfile: settings.micProfile,
      });
      rawText = asrResult.rawText;
      detectedLanguage = asrResult.detectedLanguage;
      asrUsage = asrResult.usage;
    } catch (err) {
      if (this.disposed || this.sessionId !== activeSessionId) return;
      const msg = err instanceof Error ? err.message : 'Transcription failed';
      this.enterErrorState(msg);
      return;
    }

    if (this.disposed || this.sessionId !== activeSessionId) return;

    const snippets = this.deps.db.listSnippets();
    const regexRules = this.deps.db.listRegexRules();
    const trace = runTextPipeline(rawText, {
      dictionary,
      snippets,
      regexRules,
      cleanup: settings.cleanup,
      targetAppName: capturedApp.processName,
    });

    if (trace.matchedDictionaryIds.length > 0) {
      this.deps.db.incrementDictionaryUsage(trace.matchedDictionaryIds);
    }
    if (trace.matchedSnippetIds.length > 0) {
      this.deps.db.incrementSnippetUsage(trace.matchedSnippetIds);
    }

    const textToPaste = trace.finalOutput;
    if (!textToPaste.trim()) {
      this.sessionId = null;
      this.recordingStartedAt = null;
      this.activeForegroundApp = null;
      this.state = this.computeIdleState();
      this.emitHudState();
      return;
    }

    const pasteResult = await this.deps.platform.pasteText({
      text: textToPaste,
      restoreClipboard: settings.restoreClipboardAfterPaste,
      isTerminal: capturedApp.isTerminal,
      terminalMode: settings.terminalPasteMode,
      linuxPasteBackend: settings.linuxPasteBackend,
    });

    if (this.disposed || this.sessionId !== activeSessionId) return;

    const e2eLatencyMs = Date.now() - e2eStart;
    const numWords = textToPaste.trim().split(/\s+/).filter(Boolean).length;
    const historyEntry = this.deps.db.addHistory({
      timestamp: new Date().toISOString(),
      asrText: rawText,
      formattedText: textToPaste,
      pastedText: textToPaste,
      appName: capturedApp.processName,
      windowTitle: capturedApp.title,
      durationSec: Math.max(0, payload.totalDurationMs / 1000),
      speechDurationSec: Math.max(0, payload.speechDurationMs / 1000),
      numWords,
      e2eLatencyMs,
      language: detectedLanguage || settings.language,
      micDevice: settings.microphoneDeviceId,
      archived: false,
      promptTokens: asrUsage?.promptTokens ?? 0,
      completionTokens: asrUsage?.completionTokens ?? 0,
      totalTokens: asrUsage?.totalTokens ?? 0,
      tokensEstimated: asrUsage?.estimated ?? false,
    });
    this.deps.onHistoryAdded(historyEntry);
    if (payload.opusBuffer && payload.opusBuffer.length > 0 && this.deps.corpusStore) {
      void this.deps.corpusStore.saveClip(historyEntry.id, payload.opusBuffer).catch(() => {});
    }

    this.sessionId = null;
    this.recordingStartedAt = null;
    this.activeForegroundApp = null;
    this.state = this.computeIdleState();

    if (!pasteResult.ok) {
      await this.deps.platform.copyText(textToPaste);
      this.deps.playSound('alert');
      const pasteShortcut = settings.shortcuts.pasteLast || 'Alt+Shift+Z';
      this.emitHudState({
        message: `Copied — press ${pasteShortcut} to paste`,
        kind: 'warning',
      });
      return;
    }

    this.deps.playSound('paste');
    this.emitHudState();

    scheduleCorrectionWatch(
      {
        pastedText: textToPaste,
        historyId: historyEntry.id,
        targetAppName: capturedApp.processName,
        targetWindowTitle: capturedApp.title,
        readFocusedText: this.deps.platform.readFocusedText
          ? () => this.deps.platform.readFocusedText!()
          : undefined,
        onCorrectedText: ({ historyId, correctedText }) => {
          if (this.disposed || !historyId) return;
          this.deps.db.setHistoryCorrectedText(historyId, correctedText);
        },
      },
      (candidate) => {
        if (this.disposed) return;
        const created = this.deps.db.addDictionarySuggestion({
          phrase: candidate.phrase,
          replacement: candidate.replacement,
          appName: candidate.appName,
        });
        if (created) {
          this.deps.onSuggestionsUpdated?.();
          this.clearSuggestionToastTimer();
          this.emitHudState({
            message: `Suggested: "${candidate.phrase}" → "${candidate.replacement}"`,
            kind: 'info',
          });
          this.suggestionToastTimer = setTimeout(() => {
            this.suggestionToastTimer = null;
            if (this.disposed || !this.isIdleState()) return;
            this.emitHudState();
          }, 3500);
        }
      }
    );
  }

  async handlePasteLast(): Promise<void> {
    if (this.disposed) return;
    const latest = this.deps.db.getLatestHistory();
    if (!latest) {
      this.deps.playSound('alert');
      this.emitHudState({ message: 'No recent dictation to paste', kind: 'info' });
      return;
    }

    const settings = this.deps.getSettings();
    const app = await this.deps.platform.getForegroundApp().catch(() => FALLBACK_APP);
    const pasteResult = await this.deps.platform.pasteText({
      text: latest.pastedText,
      restoreClipboard: settings.restoreClipboardAfterPaste,
      isTerminal: app.isTerminal,
      terminalMode: settings.terminalPasteMode,
      linuxPasteBackend: settings.linuxPasteBackend,
    });

    if (pasteResult.ok) {
      this.deps.playSound('paste');
      return;
    }

    await this.deps.platform.copyText(latest.pastedText);
    this.deps.playSound('alert');
    const pasteShortcut = settings.shortcuts.pasteLast || 'Alt+Shift+Z';
    this.emitHudState({
      message: `Copied — press ${pasteShortcut} to paste`,
      kind: 'warning',
    });
  }

  async handleCopyLast(): Promise<void> {
    if (this.disposed) return;
    const latest = this.deps.db.getLatestHistory();
    if (!latest) {
      this.deps.playSound('alert');
      this.emitHudState({ message: 'No recent dictation to copy', kind: 'info' });
      return;
    }

    await this.deps.platform.copyText(latest.pastedText);
    this.deps.playSound('success');
    this.emitHudState({ message: 'Copied last dictation to clipboard', kind: 'info' });
  }

  setHovering(hovering: boolean): void {
    if (this.disposed) return;
    this.isHovering = hovering;
    if (this.isIdleState()) {
      const next = this.computeIdleState();
      if (next !== this.state) {
        this.state = next;
        this.emitHudState();
      }
    }
  }

  refreshIdleVisibility(): void {
    if (this.disposed) return;
    if (this.isIdleState()) {
      this.state = this.computeIdleState();
      this.emitHudState();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearSessionTimers();
    this.clearErrorResetTimer();
    this.clearSuggestionToastTimer();
    this.sessionId = null;
    if (this.audioMutedByUs) {
      this.audioMutedByUs = false;
      void this.deps.platform.unmuteOtherAudio().catch(() => {});
    }
  }
}
