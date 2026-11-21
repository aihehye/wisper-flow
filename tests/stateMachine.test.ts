import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
// @ts-ignore Node --experimental-strip-types requires explicit .ts extension
import { AppDatabase } from '../src/main/storage/db.ts';
// @ts-ignore Node --experimental-strip-types requires explicit .ts extension
import { computeUsageStats } from '../src/main/storage/stats.ts';
// @ts-ignore Node --experimental-strip-types requires explicit .ts extension
import { buildDictionaryContextHints, DictationStateMachine, extractWindowContextTokens, isDictionaryHintEcho } from '../src/main/stateMachine.ts';
import type { AsrBackend, TranscribeRequest, TranscribeResult } from '../src/main/asr/types';
import type {
  ForegroundAppInfo,
  PlatformBridge,
  PlatformPasteOptions,
} from '../src/main/platform/types';
import type {
  AppSettings,
  HistoryEntry,
  HudPayload,
  ModelStatus,
  OmarchyEnvironment,
  SoundSlot,
} from '../src/shared/types';

function createTempDbPath(): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wisper-flow-test-'));
  return { dir, dbPath: path.join(dir, 'wisper.sqlite') };
}

function createHarness(opts?: {
  foregroundApp?: ForegroundAppInfo;
  pasteOk?: boolean;
  asrText?: string;
  asrError?: Error;
}) {
  const { dir, dbPath } = createTempDbPath();
  const db = new AppDatabase(dbPath, 'win32');

  const hudEvents: HudPayload[] = [];
  const recordCommands: Array<{
    action: 'start' | 'stop' | 'cancel';
    sessionId: string;
    deviceId: string;
    whisperMode: boolean;
    micProfile?: string;
  }> = [];
  const sounds: SoundSlot[] = [];
  const historyAdded: HistoryEntry[] = [];
  const pasteCalls: PlatformPasteOptions[] = [];
  const copyCalls: string[] = [];
  const muteCalls: number[][] = [];
  let unmuteCount = 0;
  const transcribeCalls: TranscribeRequest[] = [];

  const platform: PlatformBridge = {
    kind: 'win32',
    async start() {},
    async stop() {},
    async updateShortcuts() {},
    async startShortcutCapture() {},
    async stopShortcutCapture() {},
    async getForegroundApp() {
      return (
        opts?.foregroundApp ?? {
          processName: 'notepad.exe',
          title: 'Untitled - Notepad',
          isTerminal: false,
        }
      );
    },
    async pasteText(pasteOpts) {
      pasteCalls.push(pasteOpts);
      if (opts?.pasteOk === false) {
        return { ok: false, error: 'Elevated target window' };
      }
      return { ok: true };
    },
    async copyText(text) {
      copyCalls.push(text);
      return { ok: true };
    },
    async muteOtherAudio(excludePids) {
      muteCalls.push(excludePids);
    },
    async unmuteOtherAudio() {
      unmuteCount += 1;
    },
    async getOmarchyEnvironment() {
      return {} as OmarchyEnvironment;
    },
    getHelperPids() {
      return [4242];
    },
  };

  const asr: AsrBackend = {
    id: 'llama-server',
    async start() {},
    async stop() {},
    async restart() {},
    async listDevices() {
      return [];
    },
    getStatus(): ModelStatus {
      return {
        state: 'ready',
        engine: 'llama-server',
        modelName: 'rumble-2-flash',
        modelPresent: true,
        mmprojPresent: true,
        runtimePresent: true,
        activeDeviceId: 'Vulkan0',
        activeDeviceName: 'Mock GPU',
        availableDevices: [],
      };
    },
    async transcribe(req): Promise<TranscribeResult> {
      transcribeCalls.push(req);
      if (opts?.asrError) {
        throw opts.asrError;
      }
      return {
        rawText: opts?.asrText ?? 'language English<asr_text>hello world',
        detectedLanguage: 'English',
        asrLatencyMs: 85,
      };
    },
    onStatusChange() {
      return () => {};
    },
  };

  const sm = new DictationStateMachine({
    getSettings: (): AppSettings => db.getSettings(),
    platform,
    asr,
    db,
    sendHudState: (payload) => hudEvents.push(payload),
    sendRecordCommand: (cmd) => recordCommands.push(cmd),
    playSound: (slot) => sounds.push(slot),
    onHistoryAdded: (entry) => historyAdded.push(entry),
    getExtraExcludePids: () => [9999],
  });

  const cleanup = () => {
    sm.dispose();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };

  return {
    db,
    sm,
    hudEvents,
    recordCommands,
    sounds,
    historyAdded,
    pasteCalls,
    copyCalls,
    muteCalls,
    getUnmuteCount: () => unmuteCount,
    transcribeCalls,
    cleanup,
  };
}

describe('DictationStateMachine', () => {
  it('cancels cleanly on short tap < 500ms without invoking ASR or error sound', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    const h = createHarness();
    try {
      await h.sm.handlePttDown();
      assert.equal(h.sm.getState(), 'active_ptt');
      assert.equal(h.muteCalls.length, 1);
      assert.ok(h.muteCalls[0].includes(4242));
      assert.ok(h.muteCalls[0].includes(9999));

      t.mock.timers.tick(150);
      await h.sm.handlePttUp();

      assert.equal(h.sm.getState(), 'resting');
      assert.equal(h.transcribeCalls.length, 0);
      assert.equal(h.getUnmuteCount(), 1);
      assert.equal(h.recordCommands.at(-1)?.action, 'cancel');
      assert.equal(h.sounds.includes('error'), false);

      // Second short tap outside the double-tap window shows gentle guidance toast
      t.mock.timers.tick(700);
      await h.sm.handlePttDown();
      t.mock.timers.tick(100);
      await h.sm.handlePttUp();

      assert.equal(h.hudEvents.at(-1)?.toastMessage, 'Hold key to dictate, or double-tap for hands-free');
      assert.equal(h.sounds.includes('error'), false);
    } finally {
      h.cleanup();
    }
  });

  it('promotes double tap within 450ms to active_popo and stays recording on key release', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    const h = createHarness();
    try {
      // First short tap
      await h.sm.handlePttDown();
      t.mock.timers.tick(80);
      await h.sm.handlePttUp();
      assert.equal(h.sm.getState(), 'resting');

      // Second tap within 450ms -> promotes to active_popo
      t.mock.timers.tick(150);
      await h.sm.handlePttDown();
      assert.equal(h.sm.getState(), 'active_popo');
      assert.equal(h.sounds.at(-1), 'popoLock');

      // Releasing PTT key must NOT stop hands-free recording
      t.mock.timers.tick(200);
      await h.sm.handlePttUp();
      assert.equal(h.sm.getState(), 'active_popo');

      // Stopping hands-free transitions to processing and unmutes
      await h.sm.handleHandsFreeToggle();
      assert.equal(h.sm.getState(), 'processing');
      assert.equal(h.recordCommands.at(-1)?.action, 'stop');
      assert.equal(h.sounds.at(-1), 'stop');
      assert.equal(h.getUnmuteCount(), 2);
    } finally {
      h.cleanup();
    }
  });

  it('silently cancels active_ptt on handlePttOtherKey with zero sound, toast, or ASR call', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    const h = createHarness();
    try {
      await h.sm.handlePttDown();
      assert.equal(h.sm.getState(), 'active_ptt');
      const soundsBefore = h.sounds.length;

      t.mock.timers.tick(120);
      await h.sm.handlePttOtherKey();

      assert.equal(h.sm.getState(), 'resting');
      assert.equal(h.sounds.length, soundsBefore);
      assert.equal(h.hudEvents.at(-1)?.toastMessage, undefined);
      assert.equal(h.transcribeCalls.length, 0);
      assert.equal(h.recordCommands.at(-1)?.action, 'cancel');
      assert.equal(h.getUnmuteCount(), 1);
    } finally {
      h.cleanup();
    }
  });

  it('runs full PTT flow: mute -> transcribe -> pipeline -> paste -> unmute -> history', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    const h = createHarness({
      foregroundApp: {
        processName: 'wezterm-gui.exe',
        title: 'bash',
        isTerminal: true,
      },
      asrText: 'language English<asr_text>Um, open my kube cluster ticket 77!',
    });

    try {
      const dictHint = h.db.upsertDictionary({ phrase: 'kubectl', replacement: null });
      const dictReplace = h.db.upsertDictionary({
        phrase: 'kube cluster',
        replacement: 'Kubernetes cluster',
      });
      const snippet = h.db.upsertSnippet({
        trigger: 'my',
        expansion: 'our',
        exactOnly: false,
      });
      h.db.upsertRegexRule({
        name: 'Ticket Link',
        pattern: 'ticket (\\d+)',
        replacement: 'ISSUE-$1',
        flags: 'giu',
      });

      await h.sm.handlePttDown();
      assert.equal(h.sm.getState(), 'active_ptt');
      assert.equal(h.muteCalls.length, 1);

      const startCmd = h.recordCommands.find((c) => c.action === 'start');
      assert.ok(startCmd?.sessionId);
      assert.equal(startCmd.micProfile, 'quiet');
      assert.equal(startCmd.whisperMode, true);

      t.mock.timers.tick(650);
      await h.sm.handlePttUp();

      assert.equal(h.sm.getState(), 'processing');
      assert.equal(h.getUnmuteCount(), 1);

      await h.sm.handleAudioSubmitted({
        sessionId: startCmd.sessionId,
        wavBuffer: Buffer.from([1, 2, 3, 4]),
        speechDurationMs: 1500,
        totalDurationMs: 2000,
        isSilent: false,
      });

      assert.equal(h.sm.getState(), 'resting');
      assert.equal(h.transcribeCalls.length, 1);
      assert.equal(h.transcribeCalls[0].micProfile, 'quiet');
      assert.deepEqual(h.transcribeCalls[0].contextHints, ['kubectl', 'Kubernetes cluster']);

      assert.equal(h.pasteCalls.length, 1);
      assert.equal(h.pasteCalls[0].text, 'Open our Kubernetes cluster ISSUE-77!');
      assert.equal(h.pasteCalls[0].isTerminal, true);
      assert.equal(h.sounds.at(-1), 'paste');

      const history = h.db.listHistory();
      assert.equal(history.length, 1);
      assert.equal(history[0].pastedText, 'Open our Kubernetes cluster ISSUE-77!');
      assert.equal(history[0].appName, 'wezterm-gui.exe');
      assert.equal(history[0].numWords, 5);
      assert.equal(h.historyAdded.length, 1);

      const updatedDict = h.db.listDictionary();
      assert.equal(updatedDict.find((d) => d.id === dictReplace.id)?.frequencyUsed, 1);
      assert.equal(updatedDict.find((d) => d.id === dictHint.id)?.frequencyUsed, 0);
      const updatedSnippets = h.db.listSnippets();
      assert.equal(updatedSnippets.find((s) => s.id === snippet.id)?.frequencyUsed, 1);
    } finally {
      h.cleanup();
    }
  });

  it('aborts active dictation cleanly on handleCancel, unmutes audio, and ignores stale submission', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    const h = createHarness();
    try {
      await h.sm.handleHandsFreeToggle();
      assert.equal(h.sm.getState(), 'active_popo');
      const sessionId = h.recordCommands.at(-1)!.sessionId;

      await h.sm.handleCancel();
      assert.equal(h.sm.getState(), 'resting');
      assert.equal(h.recordCommands.at(-1)?.action, 'cancel');
      assert.equal(h.getUnmuteCount(), 1);

      // Late audio submission for the cancelled session must be ignored
      await h.sm.handleAudioSubmitted({
        sessionId,
        wavBuffer: Buffer.from([1, 2, 3]),
        speechDurationMs: 1000,
        totalDurationMs: 1000,
      });
      assert.equal(h.transcribeCalls.length, 0);
      assert.equal(h.db.listHistory().length, 0);
    } finally {
      h.cleanup();
    }
  });

  it('handles silent audio error toast with auto-reset and clipboard fallback on paste failure', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    const h = createHarness({ pasteOk: false, asrText: 'Test fallback text' });
    try {
      // Silent mic path
      await h.sm.handleDirectPttStart();
      const s1 = h.recordCommands.at(-1)!.sessionId;
      t.mock.timers.tick(600);
      await h.sm.handleDirectPttStop();
      // Idempotent second call must be a no-op
      await h.sm.handleDirectPttStop();

      await h.sm.handleAudioSubmitted({
        sessionId: s1,
        wavBuffer: Buffer.alloc(0),
        speechDurationMs: 0,
        totalDurationMs: 600,
        isSilent: true,
      });

      assert.equal(h.sm.getState(), 'error');
      assert.equal(h.sounds.at(-1), 'error');
      assert.equal(h.hudEvents.at(-1)?.toastMessage, 'No audio detected — check your microphone');

      t.mock.timers.tick(3500);
      assert.equal(h.sm.getState(), 'resting');

      // Paste failure clipboard fallback
      await h.sm.handleDirectPttStart();
      const s2 = h.recordCommands.at(-1)!.sessionId;
      t.mock.timers.tick(600);
      await h.sm.handleDirectPttStop();
      await h.sm.handleAudioSubmitted({
        sessionId: s2,
        wavBuffer: Buffer.from([1, 2, 3]),
        speechDurationMs: 800,
        totalDurationMs: 1000,
      });

      assert.deepEqual(h.copyCalls, ['Test fallback text']);
      assert.equal(h.sounds.at(-1), 'alert');
      assert.equal(h.hudEvents.at(-1)?.toastMessage, 'Copied — press Alt+Shift+Z to paste');

      await h.sm.handleCopyLast();
      assert.deepEqual(h.copyCalls, ['Test fallback text', 'Test fallback text']);
    } finally {
      h.cleanup();
    }
  });
});

describe('AppDatabase & computeUsageStats', () => {
  it('deep-merges settings, reorders regex rules, searches history, and computes stats', () => {
    const { dir, dbPath } = createTempDbPath();
    const db = new AppDatabase(dbPath, 'linux');
    try {
      const updated = db.updateSettings({
        shortcuts: { pushToTalk: 'F13' } as AppSettings['shortcuts'],
        cleanup: { allLowercaseApps: ['discord'] } as AppSettings['cleanup'],
      });
      assert.equal(updated.shortcuts.pushToTalk, 'F13');
      assert.equal(updated.shortcuts.handsFree, 'Alt+Space');
      assert.deepEqual(updated.cleanup.allLowercaseApps, ['discord']);
      assert.equal(updated.cleanup.stripExtraFillers, true);

      const r1 = db.upsertRegexRule({ name: 'First', pattern: 'a', replacement: 'b' });
      const r2 = db.upsertRegexRule({ name: 'Second', pattern: 'c', replacement: 'd' });
      const reordered = db.reorderRegexRules([r2.id, r1.id]);
      assert.deepEqual(
        reordered.map((r) => r.name),
        ['Second', 'First']
      );

      const now = new Date();
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      const twoDaysAgo = new Date(now);
      twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

      db.addHistory({
        timestamp: twoDaysAgo.toISOString(),
        asrText: 'alpha',
        formattedText: 'alpha',
        pastedText: 'alpha',
        appName: 'code',
        windowTitle: 'editor',
        durationSec: 15,
        speechDurationSec: 15,
        numWords: 20,
        e2eLatencyMs: 100,
        language: 'English',
        micDevice: 'default',
        archived: false,
      });
      db.addHistory({
        timestamp: yesterday.toISOString(),
        asrText: 'beta',
        formattedText: 'beta',
        pastedText: 'beta',
        appName: 'slack',
        windowTitle: 'chat',
        durationSec: 15,
        speechDurationSec: 15,
        numWords: 20,
        e2eLatencyMs: 100,
        language: 'English',
        micDevice: 'default',
        archived: false,
      });
      db.addHistory({
        timestamp: now.toISOString(),
        asrText: 'gamma searchme',
        formattedText: 'gamma searchme',
        pastedText: 'gamma searchme',
        appName: 'ghostty',
        windowTitle: 'term',
        durationSec: 30,
        speechDurationSec: 30,
        numWords: 40,
        e2eLatencyMs: 120,
        language: 'English',
        micDevice: 'default',
        archived: false,
      });

      assert.equal(db.listHistory({ search: 'searchme' }).length, 1);
      assert.equal(db.getLatestHistory()?.pastedText, 'gamma searchme');

      const stats = computeUsageStats(db.listHistory());
      assert.equal(stats.totalWords, 80);
      assert.equal(stats.totalDictations, 3);
      assert.equal(stats.averageWpm, 80);
      assert.equal(stats.todayWords, 40);
      assert.equal(stats.streakDays, 3);
      assert.equal(stats.timeSavedMinutes, 1);

      // Backward compatibility: legacy settings without micProfile default to 'quiet'
      assert.equal(db.getSettings().micProfile, 'quiet');
      assert.equal(db.updateSettings({ micProfile: 'noisy' }).micProfile, 'noisy');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildDictionaryContextHints', () => {
  it('uses target replacement spellings, trims, drops empties/disabled, and deduplicates case-insensitively', () => {
    const hints = buildDictionaryContextHints([
      { enabled: true, phrase: '  baller plate  ', replacement: '  Boilerplate  ' },
      { enabled: true, phrase: 'whisper through', replacement: 'Wispr Flow' },
      { enabled: true, phrase: 'wisper flow', replacement: 'wispr flow' },
      { enabled: true, phrase: 'kubectl', replacement: null },
      { enabled: true, phrase: 'Kubectl', replacement: '   ' },
      { enabled: false, phrase: 'disabled phrase', replacement: 'DisabledTarget' },
      { enabled: true, phrase: '   ', replacement: null },
      { enabled: true, phrase: '   ', replacement: '   ' },
      { enabled: true, phrase: 'doshin', replacement: 'Notion' },
    ]);

    assert.deepEqual(hints, ['Boilerplate', 'Wispr Flow', 'kubectl', 'Notion']);
  });

  it('excludes <=3-char ALL-CAPS acronyms from neural Vocabulary prompt and includes active window proper nouns', () => {
    const hints = buildDictionaryContextHints(
      [
        { enabled: true, phrase: 'ui', replacement: 'UI' },
        { enabled: true, phrase: 'ux', replacement: 'UX' },
        { enabled: true, phrase: 'cli', replacement: 'CLI' },
        { enabled: true, phrase: 'api', replacement: 'API' },
        { enabled: true, phrase: 'cpu', replacement: 'CPU' },
        { enabled: true, phrase: 'gpu', replacement: 'GPU' },
        { enabled: true, phrase: 'ssh', replacement: 'SSH' },
        { enabled: true, phrase: 'sql', replacement: 'SQL' },
        { enabled: true, phrase: 'wisper flow', replacement: 'Wisper Flow' },
      ],
      'T3Code - Antigravity on Omarchy (Neon) - Google Chrome'
    );

    assert.deepEqual(hints, ['Wisper Flow', 'T3Code', 'Antigravity', 'Omarchy', 'Neon']);
    assert.deepEqual(
      extractWindowContextTokens('T3Code - Antigravity on Omarchy (Neon) - Visual Studio Code'),
      ['T3Code', 'Antigravity', 'Omarchy', 'Neon']
    );
  });
});

describe('isDictionaryHintEcho & zero-speech hint suppression', () => {
  it('flags Vocabulary: prefix and multi-hint hallucinations on near-silent audio without dropping real speech', () => {
    const hints = ['Wisper Flow', 'Kubernetes', 'Poco X7 Pro'];
    assert.equal(isDictionaryHintEcho('Vocabulary: Wisper Flow, Kubernetes', hints, 500), true);
    assert.equal(isDictionaryHintEcho('Wisper Flow, Kubernetes.', hints, 0), true);
    assert.equal(isDictionaryHintEcho('Wisper Flow, Kubernetes.', hints, 120), true);
    assert.equal(isDictionaryHintEcho('Wisper Flow', hints, 120), false);
    assert.equal(isDictionaryHintEcho('Wisper Flow, Kubernetes.', hints, 400), false);
    assert.equal(isDictionaryHintEcho('Check my Kubernetes cluster.', hints, 0), false);
  });

  it('omits contextHints when speechDurationMs is 0 and does not paste dictionary echoes', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    const h = createHarness({
      asrText: 'Vocabulary: kubectl, Wisper Flow',
    });

    try {
      h.db.upsertDictionary({ phrase: 'kubectl', replacement: null });
      h.db.upsertDictionary({ phrase: 'wisper flow', replacement: 'Wisper Flow' });

      await h.sm.handlePttDown();
      const startCmd = h.recordCommands.find((c) => c.action === 'start');
      assert.ok(startCmd?.sessionId);

      t.mock.timers.tick(650);
      await h.sm.handlePttUp();

      await h.sm.handleAudioSubmitted({
        sessionId: startCmd.sessionId,
        wavBuffer: Buffer.from([1, 2, 3, 4]),
        speechDurationMs: 0,
        totalDurationMs: 650,
        isSilent: false,
      });

      assert.equal(h.transcribeCalls.length, 1);
      assert.equal(h.transcribeCalls[0].contextHints, undefined);
      assert.equal(h.pasteCalls.length, 0);
    } finally {
      h.cleanup();
    }
  });
});
