import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// @ts-ignore Node --experimental-strip-types requires explicit .ts extension
import { extractCorrectionCandidates, scheduleCorrectionWatch } from '../src/main/pipeline/correctionWatcher.ts';

describe('extractCorrectionCandidates', () => {
  it('detects a single-word case or spelling correction', () => {
    const res = extractCorrectionCandidates(
      'I use antigravity for coding every day',
      'I use Antigravity for coding every day'
    );
    assert.deepEqual(res, [{ phrase: 'antigravity', replacement: 'Antigravity' }]);
  });

  it('detects a two-word phrase correction like whisper flow -> Wisper Flow', () => {
    const res = extractCorrectionCandidates(
      'Please open whisper flow right now',
      'Please open Wisper Flow right now'
    );
    assert.deepEqual(res, [{ phrase: 'whisper flow', replacement: 'Wisper Flow' }]);
  });

  it('detects up to three consecutive changed words', () => {
    const res = extractCorrectionCandidates(
      'Run the open ai cli today',
      'Run the OpenAI CLI agent today'
    );
    assert.deepEqual(res, [{ phrase: 'open ai cli', replacement: 'OpenAI CLI agent' }]);
  });

  it('handles 2-to-1 and 1-to-2 word splits/merges', () => {
    assert.deepEqual(
      extractCorrectionCandidates('Deploy to kuber netes cluster', 'Deploy to Kubernetes cluster'),
      [{ phrase: 'kuber netes', replacement: 'Kubernetes' }]
    );
    assert.deepEqual(
      extractCorrectionCandidates('Open wisperflow settings', 'Open Wisper Flow settings'),
      [{ phrase: 'wisperflow', replacement: 'Wisper Flow' }]
    );
  });

  it('handles short 1-3 word pastes edited in place', () => {
    assert.deepEqual(extractCorrectionCandidates('whisper flow', 'Wisper Flow'), [
      { phrase: 'whisper flow', replacement: 'Wisper Flow' },
    ]);
    assert.deepEqual(extractCorrectionCandidates('kuber netes', 'Kubernetes'), [
      { phrase: 'kuber netes', replacement: 'Kubernetes' },
    ]);
    assert.deepEqual(extractCorrectionCandidates('Twitter.', 'X'), [
      { phrase: 'Twitter', replacement: 'X' },
    ]);
  });

  it('locates pastedText embedded inside a larger document', () => {
    const pasted = 'We should migrate the sqlite database to wal mode soon';
    const edited = [
      'Hey team, quick update on the project.',
      '',
      'We should migrate the SQLite database to WAL mode soon.',
      '',
      'Let me know what you think!',
    ].join('\n');

    const res = extractCorrectionCandidates(pasted, edited);
    assert.deepEqual(res, [
      { phrase: 'sqlite', replacement: 'SQLite' },
      { phrase: 'wal', replacement: 'WAL' },
    ]);
  });

  it('ignores pure punctuation-only edits', () => {
    assert.deepEqual(
      extractCorrectionCandidates(
        'hello world how are you',
        'hello, world! how are you?'
      ),
      []
    );
  });

  it('ignores identical, empty, or whitespace-only inputs', () => {
    assert.deepEqual(extractCorrectionCandidates('', 'hello'), []);
    assert.deepEqual(extractCorrectionCandidates('hello', ''), []);
    assert.deepEqual(extractCorrectionCandidates('hello world', 'hello world'), []);
    assert.deepEqual(extractCorrectionCandidates('   ', '   '), []);
  });

  it('ignores pure insertions and pure deletions', () => {
    assert.deepEqual(
      extractCorrectionCandidates('I use this tool daily', 'I really use this tool daily'),
      []
    );
    assert.deepEqual(
      extractCorrectionCandidates('I really use this tool daily', 'I use this tool daily'),
      []
    );
  });

  it('ignores huge changes (> 3 consecutive words) and full rewrites', () => {
    assert.deepEqual(
      extractCorrectionCandidates(
        'The quick brown fox jumps over the lazy dog',
        'The slow red cat leaps past the lazy dog'
      ),
      []
    );
    assert.deepEqual(
      extractCorrectionCandidates(
        'Please send the quarterly report to finance',
        'Completely unrelated message about dinner plans tonight'
      ),
      []
    );
  });
});

describe('scheduleCorrectionWatch', () => {
  it('emits candidates once text settles across two consecutive polls and stops watching', async () => {
    let pollCount = 0;
    const emitted: Array<{ phrase: string; replacement: string; appName: string }> = [];

    scheduleCorrectionWatch(
      {
        pastedText: 'I use whisper flow daily',
        targetAppName: 'code.exe',
        pollDelaysMs: [15, 35, 55, 80],
        readFocusedText: async () => {
          pollCount++;
          if (pollCount === 1) {
            return { ok: true, text: 'I use whisper flow daily', processName: 'code.exe' };
          }
          return { ok: true, text: 'I use Wisper Flow daily', processName: 'code.exe' };
        },
      },
      (c) => emitted.push(c)
    );

    await new Promise((r) => setTimeout(r, 120));
    assert.equal(pollCount, 3);
    assert.deepEqual(emitted, [
      { phrase: 'whisper flow', replacement: 'Wisper Flow', appName: 'code.exe' },
    ]);
  });

  it('ignores mid-typing edits until text settles across two consecutive polls', async () => {
    let pollCount = 0;
    const emitted: Array<{ phrase: string; replacement: string; appName: string }> = [];
    const snapshots = [
      'I use whisper flow daily',
      'I use Wis daily',
      'I use Wisper Flow daily',
      'I use Wisper Flow daily',
    ];

    scheduleCorrectionWatch(
      {
        pastedText: 'I use whisper flow daily',
        targetAppName: 'code.exe',
        pollDelaysMs: [10, 30, 50, 70, 95],
        readFocusedText: async () => {
          const text = snapshots[Math.min(pollCount, snapshots.length - 1)];
          pollCount++;
          return { ok: true, text, processName: 'code.exe' };
        },
      },
      (c) => emitted.push(c)
    );

    await new Promise((r) => setTimeout(r, 130));
    assert.equal(pollCount, 4);
    assert.deepEqual(emitted, [
      { phrase: 'whisper flow', replacement: 'Wisper Flow', appName: 'code.exe' },
    ]);
  });

  it('cancels prior active watch when a new dictation is pasted', async () => {
    let firstPolls = 0;
    let secondPolls = 0;

    scheduleCorrectionWatch(
      {
        pastedText: 'first dictation text here',
        targetAppName: 'notepad.exe',
        pollDelaysMs: [30, 60],
        readFocusedText: async () => {
          firstPolls++;
          return { ok: true, text: 'first dictation text here', processName: 'notepad.exe' };
        },
      },
      () => {}
    );

    const cancelSecond = scheduleCorrectionWatch(
      {
        pastedText: 'second dictation text here',
        targetAppName: 'notepad.exe',
        pollDelaysMs: [20],
        readFocusedText: async () => {
          secondPolls++;
          return { ok: true, text: 'second dictation text here', processName: 'notepad.exe' };
        },
      },
      () => {}
    );

    await new Promise((r) => setTimeout(r, 90));
    cancelSecond();
    assert.equal(firstPolls, 0);
    assert.equal(secondPolls, 1);
  });

  it('stops immediately on password field', async () => {
    let passwordPolls = 0;
    scheduleCorrectionWatch(
      {
        pastedText: 'secret text here',
        targetAppName: 'chrome.exe',
        pollDelaysMs: [10, 30, 60],
        readFocusedText: async () => {
          passwordPolls++;
          return { ok: false, reason: 'password', processName: 'chrome.exe' };
        },
      },
      () => {}
    );

    await new Promise((r) => setTimeout(r, 80));
    assert.equal(passwordPolls, 1);
  });

  it('stops immediately on foreground app change', async () => {
    let appChangePolls = 0;
    scheduleCorrectionWatch(
      {
        pastedText: 'other text here',
        targetAppName: 'chrome.exe',
        pollDelaysMs: [15, 35, 65],
        readFocusedText: async () => {
          appChangePolls++;
          return { ok: true, text: 'other text here', processName: 'slack.exe' };
        },
      },
      () => {}
    );

    await new Promise((r) => setTimeout(r, 80));
    assert.equal(appChangePolls, 1);
  });
});
