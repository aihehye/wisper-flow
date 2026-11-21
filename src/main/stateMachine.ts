import crypto from 'node:crypto';
// @ts-ignore Node --experimental-strip-types requires explicit .ts extension
import { DICTATION_DEBOUNCE_MS, DOUBLE_TAP_WINDOW_MS, MAX_RECORDING_STOP_MS, MAX_RECORDING_WARN_MS } from '../shared/defaults.ts';
// @ts-ignore Node --experimental-strip-types requires explicit .ts extension
import { runTextPipeline } from './pipeline/textPipeline.ts';
// @ts-ignore Node --experimental-strip-types requires explicit .ts extension
import { recordCorrectionSighting, scheduleCorrectionWatch, shouldAutoPromoteCorrection } from './pipeline/correctionWatcher.ts';
// @ts-ignore Node --experimental-strip-types requires explicit .ts extension
import { fixKeyboardTypos } from './pipeline/typoFixer.ts';
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

const WINDOW_TITLE_STOPWORDS = new Set([
  'administrator', 'application', 'browser', 'chrome', 'code', 'command', 'default', 'desktop',
  'document', 'edge', 'edit', 'explorer', 'file', 'firefox', 'google', 'help', 'home', 'inbox',
  'microsoft', 'mozilla', 'new', 'open', 'page', 'personal', 'powershell', 'profile', 'prompt',
  'save', 'search', 'settings', 'studio', 'tab', 'terminal', 'untitled', 'view', 'visual',
  'window', 'windows', 'work',
]);

/**
 * Extracts up to `maxTokens` capitalized / CamelCase proper nouns (len >= 4)
 * from an active window title (e.g., "T3Code", "Antigravity", "Omarchy", "Neon").
 */
export function extractWindowContextTokens(windowTitle: string, maxTokens = 10): string[] {
  if (!windowTitle || maxTokens <= 0) return [];

  const tokens: string[] = [];
  const seen = new Set<string>();
  const matches = windowTitle.match(/\b[A-Z][A-Za-z0-9]{3,}\b/g);
  if (!matches) return [];

  for (const raw of matches) {
    const lower = raw.toLowerCase();
    if (WINDOW_TITLE_STOPWORDS.has(lower)) continue;
    // Skip pure ALL-CAPS short/generic acronyms
    if (raw.length <= 3 && raw === raw.toUpperCase()) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    tokens.push(raw);
    if (tokens.length >= maxTokens) break;
  }

  return tokens;
}

/**
 * Builds deduplicated ASR vocabulary hints from enabled dictionary entries
 * (excluding <=3-char ALL-CAPS acronyms that over-bias the neural prompt)
 * plus up to 10 proper nouns extracted from the active window title.
 */
export function buildDictionaryContextHints(
  dictionary: ReadonlyArray<Pick<DictionaryEntry, 'enabled' | 'phrase' | 'replacement'>>,
  windowTitle?: string
): string[] {
  const seen = new Set<string>();
  const hints: string[] = [];

  for (const entry of dictionary) {
    if (!entry.enabled) continue;
    const hint = entry.replacement?.trim() || entry.phrase.trim();
    if (!hint) continue;

    // Exclude <= 3 char ALL-CAPS acronyms (UI, UX, CLI, API, CPU, GPU, SSH, SQL)
    // from the neural Vocabulary: prompt; textPipeline.ts still replaces them deterministically.
    if (hint.length <= 3 && /^[A-Z0-9]+$/.test(hint) && /[A-Z]/.test(hint)) {
      continue;
    }

    const normalized = hint.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    hints.push(hint);
  }

  if (windowTitle) {
    for (const token of extractWindowContextTokens(windowTitle, 10)) {
      const normalized = token.toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      hints.push(token);
    }
  }

  return hints;
}

/**
 * Detects when an ASR model hallucinates the injected `Vocabulary: ...` system prompt
 * on silent or near-silent audio instead of transcribing real speech.
 */
export function isDictionaryHintEcho(
  rawText: string,
  contextHints: readonly string[] | undefined,
  speechDurationMs: number
): boolean {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return false;
  }

  if (/^vocabulary\s*:/i.test(trimmed)) {
    return true;
  }

  if (!contextHints || contextHints.length === 0) {
    return false;
  }

  if (speechDurationMs >= 250) {
    return false;
  }

  const hintSet = new Set(
    contextHints
      .map((h) => h.trim().toLowerCase().replace(/[.!?]+$/g, ''))
      .filter(Boolean)
  );
  if (hintSet.size === 0) return false;

  const parts = trimmed
    .split(/[,;\n]+/)
    .map((p) => p.trim().toLowerCase().replace(/[.!?]+$/g, ''))
    .filter(Boolean);

  return parts.length >= 2 && parts.every((p) => hintSet.has(p));
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

  showTransientToast(
    message: string,
    kind: 'info' | 'warning' | 'error' = 'info',
    durationMs = 2800
  ): void {
    if (this.disposed) return;
    this.clearSuggestionToastTimer();
    this.emitHudState({ message, kind });
    this.suggestionToastTimer = setTimeout(() => {
      this.suggestionToastTimer = null;
      if (this.disposed || !this.isIdleState()) return;
      this.emitHudState();
    }, durationMs);
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
    const windowContextTokens = extractWindowContextTokens(capturedApp.title, 10);
    const hasPreGainSpeech = payload.speechDurationMs > 0;
    const contextHints =
      settings.useDictionaryHints && hasPreGainSpeech
        ? buildDictionaryContextHints(dictionary, capturedApp.title)
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
      rawText = isDictionaryHintEcho(asrResult.rawText, contextHints, payload.speechDurationMs)
        ? ''
        : asrResult.rawText;
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
      contextTerms: windowContextTokens,
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
        const seenCount = recordCorrectionSighting(candidate.phrase, candidate.replacement);
        const autoPromote = shouldAutoPromoteCorrection(
          candidate.phrase,
          candidate.replacement,
          seenCount
        );

        if (autoPromote) {
          const phraseLower = candidate.phrase.trim().toLowerCase();
          const alreadyExists = this.deps.db
            .listDictionary()
            .some((d) => d.phrase.trim().toLowerCase() === phraseLower);
          if (!alreadyExists && phraseLower !== candidate.replacement.trim().toLowerCase()) {
            this.deps.db.upsertDictionary({
              phrase: candidate.phrase,
              replacement: candidate.replacement,
              enabled: true,
            });
            this.deps.onSuggestionsUpdated?.();
            this.showTransientToast(
              `Learned: "${candidate.phrase}" → "${candidate.replacement}"`,
              'info'
            );
            return;
          }
        }

        const created = this.deps.db.addDictionarySuggestion({
          phrase: candidate.phrase,
          replacement: candidate.replacement,
          appName: candidate.appName,
        });
        if (created) {
          this.deps.onSuggestionsUpdated?.();
          this.showTransientToast(
            `Suggested: "${candidate.phrase}" → "${candidate.replacement}"`,
            'info'
          );
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

  async handleFixInputBox(): Promise<void> {
    if (this.disposed) return;
    if (!this.deps.platform.selectAllAndCopy) {
      this.deps.playSound('alert');
      this.showTransientToast('Fix Input Box not supported on this platform', 'warning');
      return;
    }

    const copied = await this.deps.platform.selectAllAndCopy();
    if (!copied.ok || !copied.text || !copied.text.trim()) {
      this.deps.playSound('alert');
      this.showTransientToast('No text found in active input box', 'info');
      return;
    }

    const dictionary = this.deps.db.listDictionary();
    const fixed = fixKeyboardTypos(copied.text, dictionary);

    if (fixed === copied.text) {
      if (typeof copied.previousClipboard === 'string') {
        await this.deps.platform.copyText(copied.previousClipboard);
      }
      this.showTransientToast('No typos found', 'info', 2000);
      return;
    }

    const settings = this.deps.getSettings();
    const app = await this.deps.platform.getForegroundApp().catch(() => FALLBACK_APP);
    const pasteResult = await this.deps.platform.pasteText({
      text: fixed,
      restoreClipboard: false,
      isTerminal: app.isTerminal,
      terminalMode: settings.terminalPasteMode,
      linuxPasteBackend: settings.linuxPasteBackend,
    });

    if (settings.restoreClipboardAfterPaste && typeof copied.previousClipboard === 'string') {
      const prev = copied.previousClipboard;
      setTimeout(() => {
        if (!this.disposed) {
          void this.deps.platform.copyText(prev).catch(() => {});
        }
      }, 240);
    }

    if (pasteResult.ok) {
      this.deps.playSound('paste');
      this.showTransientToast('Fixed typos in input box', 'info', 2200);
    } else {
      await this.deps.platform.copyText(fixed);
      this.deps.playSound('alert');
      this.showTransientToast('Fixed text copied — press Ctrl+V to paste', 'warning', 3000);
    }
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
