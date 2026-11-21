import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// @ts-ignore Node --experimental-strip-types requires explicit .ts extension
import { fixKeyboardTypos } from '../src/main/pipeline/typoFixer.ts';
import type { DictionaryEntry } from '../src/shared/types';

const nowIso = '2026-01-01T00:00:00.000Z';

function makeDict(
  id: string,
  phrase: string,
  replacement: string | null = null,
  enabled = true
): DictionaryEntry {
  return {
    id,
    phrase,
    replacement,
    enabled,
    frequencyUsed: 0,
    lastUsed: null,
    createdAt: nowIso,
    modifiedAt: nowIso,
  };
}

const sampleDictionary: DictionaryEntry[] = [
  makeDict('d1', 'WhatsApp'),
  makeDict('d2', 'Omarchy'),
  makeDict('d3', 'Maniteja'),
  makeDict('d4', 'Wisper Flow'),
  makeDict('d5', 'Neon'),
  makeDict('d6', 'Flash'),
  makeDict('d7', 'subagent'),
  makeDict('d8', 'GitHub'),
];

describe('fixKeyboardTypos', () => {
  it('fixes finger transpositions and classic misspellings', () => {
    const cases: Array<[string, string]> = [
      ['htat', 'That'],
      ['snet', 'Sent'],
      ['moer', 'More'],
      ['ohter', 'Other'],
      ['updgared', 'Upgraded'],
      ['updagtred', 'Upgraded'],
      ['suabget', 'Subagent'],
      ['flahs', 'Flash'],
      ['spleing', 'Spelling'],
      ['spellong', 'Spelling'],
      ['teh', 'The'],
      ['adn', 'And'],
      ['taht', 'That'],
      ['waht', 'What'],
      ['wiht', 'With'],
      ['becuase', 'Because'],
      ['recieve', 'Receive'],
      ['definately', 'Definitely'],
      ['seperate', 'Separate'],
      ['occured', 'Occurred'],
    ];

    for (const [input, expected] of cases) {
      assert.equal(fixKeyboardTypos(input), expected, `Failed for "${input}"`);
    }
  });

  it('fixes neighbor-key QWERTY fat-fingers', () => {
    const cases: Array<[string, string]> = [
      ['explsin', 'Explain'],
      ['thid', 'This'],
      ['guewss', 'Guess'],
      ['helo', 'Hello'],
      ['wrold', 'World'],
      ['yuo', 'You'],
      ['fomr', 'From'],
    ];

    for (const [input, expected] of cases) {
      assert.equal(fixKeyboardTypos(input), expected, `Failed for "${input}"`);
    }
  });

  it('fixes phonetic and dropped-letter shortcuts without breaking msg', () => {
    const cases: Array<[string, string]> = [
      ['dictory', 'Dictionary'],
      ['whatspa', 'WhatsApp'],
      ['cobersation', 'Conversation'],
      ['dication', 'Discussion'],
      ['undertadtd', 'Understand'],
      ['poinet', 'Pointed'],
      ['promt', 'Prompt'],
      ['als', 'Also'],
      ['i sent a msg', 'I sent a msg'],
    ];

    for (const [input, expected] of cases) {
      assert.equal(fixKeyboardTypos(input), expected, `Failed for "${input}"`);
    }
  });

  it('fixes accidental space splits and compounds', () => {
    assert.equal(fixKeyboardTypos('using akey bvoard'), 'Using a keyboard');
    assert.equal(fixKeyboardTypos('with auto sugess'), 'With auto-suggest');
    assert.equal(fixKeyboardTypos('launch sub agent'), 'Launch subagent');
    assert.equal(fixKeyboardTypos('my key board is loud'), 'My keyboard is loud');
  });

  it('restores exact dictionary casing for exact and fuzzy matches', () => {
    assert.equal(
      fixKeyboardTypos('maniteja built wisper flow on omarchy', sampleDictionary),
      'Maniteja built Wisper Flow on Omarchy'
    );
    assert.equal(
      fixKeyboardTypos('check github and whatspa with neon and flash', sampleDictionary),
      'Check GitHub and WhatsApp with Neon and Flash'
    );
    assert.equal(
      fixKeyboardTypos('manitjea updated omrachy and gtihub for wispr flow', sampleDictionary),
      'Maniteja updated Omarchy and GitHub for Wisper Flow'
    );
    assert.equal(
      fixKeyboardTypos('the suabget ran flahs', sampleDictionary),
      'The subagent ran Flash'
    );
    // Disabled dictionary entry should not override
    const disabledDict = [makeDict('d-off', 'Omarchy', null, false)];
    assert.equal(fixKeyboardTypos('using omarchy', disabledDict), 'Using omarchy');

    // Replacement-based dictionary entry and possessive form
    const replacementDict = [
      makeDict('d-rep', 'wisper', 'Wisper Flow'),
      makeDict('d-man', 'Maniteja', null),
    ];
    assert.equal(
      fixKeyboardTypos("check wisper and maniteja's setup", replacementDict),
      "Check Wisper Flow and Maniteja's setup"
    );
  });

  it('capitalizes standalone i contractions and sentence starts', () => {
    assert.equal(
      fixKeyboardTypos("i think i'm ready. i've got it! i'll go? i'd stay."),
      "I think I'm ready. I've got it! I'll go? I'd stay."
    );
    assert.equal(
      fixKeyboardTypos('helo wrold. thid is fine! can yuo explsin? yes.'),
      'Hello world. This is fine! Can you explain? Yes.'
    );
  });

  it('preserves URLs, emails, file paths, CLI flags, code identifiers, numbers, and unknown names', () => {
    const input =
      'check https://github.com/manit/wisper-flow or mail manit@example.com about src/main/pipeline/typoFixer.ts and C:\\Users\\Manit\\app.log using --ozone-platform=wayland --flag myVar_1 snake_case 42 3.14.';
    assert.equal(
      fixKeyboardTypos(input),
      'Check https://github.com/manit/wisper-flow or mail manit@example.com about src/main/pipeline/typoFixer.ts and C:\\Users\\Manit\\app.log using --ozone-platform=wayland --flag myVar_1 snake_case 42 3.14.'
    );

    // Unknown proper names must stay untouched
    assert.equal(
      fixKeyboardTypos('Karthik, Srinivas, Zelensky, and Biryani'),
      'Karthik, Srinivas, Zelensky, and Biryani'
    );
    // Uncommon real English words must stay untouched
    assert.equal(
      fixKeyboardTypos('ephemeral serendipity and bizarre rhythm'),
      'Ephemeral serendipity and bizarre rhythm'
    );
  });

  it('preserves leading/trailing punctuation and whitespace/newlines', () => {
    assert.equal(
      fixKeyboardTypos('  "helo wrold," she said.\n  i\'m going (snet? yes, later).  '),
      '  "Hello world," she said.\n  I\'m going (sent? Yes, later).  '
    );
    assert.equal(fixKeyboardTypos('\n\thtat adn thid!\n'), '\n\tThat and this!\n');
    assert.equal(fixKeyboardTypos(''), '');
    assert.equal(fixKeyboardTypos('   \n  '), '   \n  ');
    assert.equal(
      fixKeyboardTypos('use local tools, e.g. grep or rg.'),
      'Use local tools, e.g. grep or rg.'
    );
  });

  it('handles realistic all-lowercase fast-typed sentences accurately', () => {
    const s1 =
      "i snet teh msg on whatspa becuase i'm using akey bvoard wiht auto sugess and i want to explsin htat we updagtred our suabget to flahs";
    assert.equal(
      fixKeyboardTypos(s1, sampleDictionary),
      "I sent the msg on WhatsApp because I'm using a keyboard with auto-suggest and I want to explain that we upgraded our subagent to Flash"
    );

    const s2 =
      'in our dication wiht maniteja fomr wisper flow, he poinet out htat teh dictory spleing was broken adn i undertadtd moer about teh cobersation';
    assert.equal(
      fixKeyboardTypos(s2, sampleDictionary),
      'In our discussion with Maniteja from Wisper Flow, he pointed out that the dictionary spelling was broken and I understand more about the conversation'
    );

    const s3 =
      'als check my promt on github. guewss waht? i recieve updates from Karthik adn Srinivas on omarchy.';
    assert.equal(
      fixKeyboardTypos(s3, sampleDictionary),
      'Also check my prompt on GitHub. Guess what? I receive updates from Karthik and Srinivas on Omarchy.'
    );
  });

  it('runs well under 10 ms per sentence on CPU', () => {
    const sentence =
      "i snet teh msg on whatspa becuase i'm using akey bvoard wiht auto sugess and i want to explsin htat we updagtred our suabget to flahs fomr wisper flow";

    // Warm up JIT
    for (let i = 0; i < 5; i++) {
      fixKeyboardTypos(sentence, sampleDictionary);
    }

    const iterations = 50;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      fixKeyboardTypos(sentence, sampleDictionary);
    }
    const avgMs = (performance.now() - start) / iterations;
    assert.ok(avgMs < 10, `Expected average latency < 10 ms, got ${avgMs.toFixed(2)} ms`);
  });
});
