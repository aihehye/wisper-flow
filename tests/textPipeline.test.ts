import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// @ts-ignore Node --experimental-strip-types requires explicit .ts extension
import { runTextPipeline, validateRegexPattern } from '../src/main/pipeline/textPipeline.ts';
import type {
  CleanupOptions,
  DictionaryEntry,
  RegexRuleEntry,
  SnippetEntry,
} from '../src/shared/types';

const nowIso = '2026-01-01T00:00:00.000Z';

function makeCleanup(overrides: Partial<CleanupOptions> = {}): CleanupOptions {
  return {
    stripExtraFillers: false,
    normalizeSpacing: false,
    spokenFormatting: false,
    allLowercaseGlobal: false,
    allLowercaseApps: [],
    ...overrides,
  };
}

function makeDict(
  id: string,
  phrase: string,
  replacement: string | null,
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

function makeSnippet(
  id: string,
  trigger: string,
  expansion: string,
  opts: { exactOnly?: boolean; enabled?: boolean } = {}
): SnippetEntry {
  return {
    id,
    trigger,
    expansion,
    exactOnly: opts.exactOnly ?? false,
    enabled: opts.enabled ?? true,
    frequencyUsed: 0,
    lastUsed: null,
    createdAt: nowIso,
    modifiedAt: nowIso,
  };
}

function makeRegex(
  id: string,
  name: string,
  pattern: string,
  replacement: string,
  sortOrder: number,
  opts: { flags?: string; enabled?: boolean } = {}
): RegexRuleEntry {
  return {
    id,
    name,
    pattern,
    flags: opts.flags ?? 'giu',
    replacement,
    enabled: opts.enabled ?? true,
    sortOrder,
    createdAt: nowIso,
    modifiedAt: nowIso,
  };
}

describe('runTextPipeline', () => {
  it('strips Rumble language/<asr_text> prefixes and outer whitespace without touching normal prose', () => {
    const res1 = runTextPipeline('  language English<asr_text>  Hello world!  ', {
      dictionary: [],
      snippets: [],
      regexRules: [],
      cleanup: makeCleanup(),
    });
    assert.equal(res1.afterPrefixStrip, 'Hello world!');
    assert.equal(res1.finalOutput, 'Hello world!');

    const res2 = runTextPipeline('<asr_text>  Namaste  ', {
      dictionary: [],
      snippets: [],
      regexRules: [],
      cleanup: makeCleanup(),
    });
    assert.equal(res2.afterPrefixStrip, 'Namaste');

    const res3 = runTextPipeline('Language detection works fine.', {
      dictionary: [],
      snippets: [],
      regexRules: [],
      cleanup: makeCleanup(),
    });
    assert.equal(res3.afterPrefixStrip, 'Language detection works fine.');
  });

  it('matches full-utterance exact snippets ignoring punctuation/case and skips cleanup', () => {
    const snippets = [
      makeSnippet('s1', 'my calendly', 'https://calendly.com/hemanth/30min\nSee you then!', {
        exactOnly: true,
      }),
      makeSnippet('s2', 'disabled trigger', 'SHOULD NOT MATCH', { enabled: false }),
    ];

    const res = runTextPipeline('language English<asr_text> My Calendly?! ', {
      dictionary: [makeDict('d1', 'calendly', 'WRONG')],
      snippets,
      regexRules: [],
      cleanup: makeCleanup({
        stripExtraFillers: true,
        normalizeSpacing: true,
        allLowercaseGlobal: true,
      }),
    });

    assert.equal(res.matchedExactSnippetId, 's1');
    assert.deepEqual(res.matchedSnippetIds, ['s1']);
    assert.deepEqual(res.matchedDictionaryIds, []);
    assert.equal(
      res.afterExactSnippet,
      'https://calendly.com/hemanth/30min\nSee you then!'
    );
    assert.equal(
      res.finalOutput,
      'https://calendly.com/hemanth/30min\nSee you then!'
    );

    const disabledRes = runTextPipeline('disabled trigger', {
      dictionary: [],
      snippets,
      regexRules: [],
      cleanup: makeCleanup(),
    });
    assert.equal(disabledRes.matchedExactSnippetId, undefined);
    assert.equal(disabledRes.finalOutput, 'disabled trigger');
  });

  it('applies longest-first Dictionary and inline Snippets with Unicode boundary and contraction guard', () => {
    const dictionary = [
      makeDict('d-short', 'new york', 'NY'),
      makeDict('d-long', 'new york city', 'NYC'),
      makeDict('d-can', 'can', 'able to'),
      makeDict('d-cafe', 'café', 'coffee shop'),
      makeDict('d-hint', 'Kubernetes', null), // hint only, never replaces
    ];
    const snippets = [
      makeSnippet('s-inline', 'sig', 'Best,\nHemanth', { exactOnly: false }),
      makeSnippet('s-exact', 'exact only', 'SHOULD_NOT_INLINE', { exactOnly: true }),
    ];

    const input =
      "I can go to new york city and new york, but I can't and can’t skip café, cannot, foo_can, Kubernetes, exact only, sig.";

    const res = runTextPipeline(input, {
      dictionary,
      snippets,
      regexRules: [],
      cleanup: makeCleanup(),
    });

    assert.equal(
      res.afterDictionaryAndInlineSnippets,
      "I able to go to NYC and NY, but I can't and can’t skip coffee shop, cannot, foo_can, Kubernetes, exact only, Best,\nHemanth."
    );
    assert.deepEqual(new Set(res.matchedDictionaryIds), new Set(['d-short', 'd-long', 'd-can', 'd-cafe']));
    assert.deepEqual(res.matchedSnippetIds, ['s-inline']);
  });

  it('applies enabled Regex Rules in ascending sortOrder, unescapes newlines/tabs, and survives invalid regex', () => {
    const regexRules = [
      makeRegex('r-second', 'Wrap issue', 'JIRA-(\\d+)', '[$1]\n', 20),
      makeRegex('r-first', 'Prefix ticket', 'ticket (\\d+)', 'JIRA-$1', 10),
      makeRegex('r-bad', 'Broken', '([unclosed', 'X', 5),
      makeRegex('r-disabled', 'Disabled', 'JIRA', 'NOPE', 1, { enabled: false }),
    ];

    const res = runTextPipeline('Please check ticket 42.', {
      dictionary: [],
      snippets: [],
      regexRules,
      cleanup: makeCleanup(),
    });

    assert.equal(res.afterRegexRules, 'Please check [42]\n.');
    assert.deepEqual(res.appliedRegexRuleIds, ['r-first', 'r-second']);

    assert.deepEqual(validateRegexPattern('JIRA-(\\d+)', 'giu'), { valid: true });
    const invalidCheck = validateRegexPattern('([unclosed', 'giu');
    assert.equal(invalidCheck.valid, false);
    assert.ok(invalidCheck.error && invalidCheck.error.length > 0);
  });

  it('performs deterministic cleanup: fillers, spoken formatting, spacing, and per-app lowercase', () => {
    const cleaned = runTextPipeline(
      'Um, hello , um, world !  Uh, check 3.14 and 1,000 at 10:30 or example.com.First.Second  new paragraph  bullet point buy umbrella new line uh-oh',
      {
        dictionary: [],
        snippets: [],
        regexRules: [],
        cleanup: makeCleanup({
          stripExtraFillers: true,
          spokenFormatting: true,
          normalizeSpacing: true,
        }),
      }
    );

    assert.equal(
      cleaned.finalOutput,
      'Hello, world! Check 3.14 and 1,000 at 10:30 or example.com. First. Second\n\n- buy umbrella\nuh-oh'
    );

    const appLower = runTextPipeline('Hello World from Slack!', {
      dictionary: [],
      snippets: [],
      regexRules: [],
      cleanup: makeCleanup({ allLowercaseApps: ['slack'] }),
      targetAppName: 'Slack.exe',
    });
    assert.equal(appLower.finalOutput, 'hello world from slack!');

    const otherApp = runTextPipeline('Hello World from VSCode!', {
      dictionary: [],
      snippets: [],
      regexRules: [],
      cleanup: makeCleanup({ allLowercaseApps: ['slack'] }),
      targetAppName: 'Code.exe',
    });
    assert.equal(otherApp.finalOutput, 'Hello World from VSCode!');
  });

  it('collapses 1-word and 2-word spoken stutters while preserving capitalization, numbers, and sentence breaks', () => {
    const runStutter = (text: string) =>
      runTextPipeline(text, {
        dictionary: [],
        snippets: [],
        regexRules: [],
        cleanup: makeCleanup({
          stripExtraFillers: true,
          normalizeSpacing: true,
        }),
      }).finalOutput;

    assert.equal(runStutter('When I when I click the the bug'), 'When I click the bug');
    assert.equal(runStutter('could you could you help'), 'could you help');
    assert.equal(runStutter('like, like I I think'), 'like I think');
    assert.equal(runStutter('um the um the issue'), 'The issue');
    assert.equal(runStutter('I I agree'), 'I agree');
    assert.equal(runStutter('Check 20 20 and Done. Done!'), 'Check 20 20 and Done. Done!');
    assert.equal(
      runStutter("I don't have any of it. I don't have any of it. I don't have any of it."),
      "I don't have any of it."
    );
    assert.equal(
      runStutter('Like try not to get try not to get try not to get stuck'),
      'Like try not to get stuck'
    );
    assert.equal(
      runStutter(
        'I do not want to run a battery driver. I do not want to run a battery driver. I do not want to run a battery driver.'
      ),
      'I do not want to run a battery driver.'
    );
    assert.equal(runStutter('Explain it and blah blah blah.'), 'Explain it and blah blah blah.');
  });

  it('matches vowel-mutated & sound-alike words against Dictionary targets and window contextTerms', () => {
    const dictionary = [
      makeDict('d1', 'maniteja', 'Maniteja'),
      makeDict('d2', 'omarchy', 'Omarchy'),
      makeDict('d3', 't3code', 'T3Code'),
      makeDict('d4', 'sonnet', 'Sonnet'),
      makeDict('d5', 'haiku', 'Haiku'),
      makeDict('d6', 'regex', 'regex'),
      makeDict('d7', 'boilerplate', 'boilerplate'),
      makeDict('d8', 'graphics card', 'graphics card'),
      makeDict('d9', 'wisper flow', 'Wisper Flow'),
      makeDict('d10', 'subagent', 'subagent'),
      makeDict('d11', 'colab', 'Colab'),
    ];

    const runPhonetic = (text: string, contextTerms?: string[]) =>
      runTextPipeline(text, {
        dictionary,
        snippets: [],
        regexRules: [],
        cleanup: makeCleanup(),
        contextTerms,
      }).finalOutput;

    assert.equal(runPhonetic('Hello Mantheja and manitija!'), 'Hello Maniteja and Maniteja!');
    assert.equal(runPhonetic('I installed Oomachi yesterday.'), 'I installed Omarchy yesterday.');
    assert.equal(runPhonetic('Open D3 code right now.'), 'Open T3Code right now.');
    assert.equal(runPhonetic('Switch to Stoornet or high cube.'), 'Switch to Sonnet or Haiku.');
    assert.equal(runPhonetic('Fix the tree checks in baller plate.'), 'Fix the regex in boilerplate.');
    assert.equal(runPhonetic('My traffic card is fast.'), 'My graphics card is fast.');
    assert.equal(runPhonetic('Try whisper flower and whisper float and whisper through.'), 'Try Wisper Flow and Wisper Flow and Wisper Flow.');
    assert.equal(runPhonetic('Spawn a sub-agent or such patient in collab.'), 'Spawn a subagent or subagent in Colab.');

    // Active window title contextTerms matching (not in dictionary)
    assert.equal(
      runPhonetic('Open Antigravty on Neonn.', ['Antigravity', 'Neon']),
      'Open Antigravity on Neon.'
    );

    // Must not corrupt normal common English prose
    assert.equal(
      runPhonetic('Check the table and label in the normal system report.'),
      'Check the table and label in the normal system report.'
    );
  });

  it('never lets phonetic fuzzy matching overwrite valid common English words like sent, sort, or sound', () => {
    const dictionary = [
      makeDict('d1', 'maniteja', 'Maniteja'),
      makeDict('d2', 'omarchy', 'Omarchy'),
      makeDict('d3', 'sonnet', 'Sonnet'),
      makeDict('d4', 'haiku', 'Haiku'),
      makeDict('d5', 'flash', 'Flash'),
      makeDict('d6', 'neon', 'Neon'),
      makeDict('d7', 'regex', 'regex'),
      makeDict('d8', 'wisper flow', 'Wisper Flow'),
    ];

    const runPhonetic = (text: string, contextTerms?: string[]) =>
      runTextPipeline(text, {
        dictionary,
        snippets: [],
        regexRules: [],
        cleanup: makeCleanup(),
        contextTerms,
      }).finalOutput;

    assert.equal(
      runPhonetic('I just sent it, it sort of works, sound is good'),
      'I just sent it, it sort of works, sound is good'
    );
    assert.equal(
      runPhonetic(
        'Send the saint to sand the rock, tried class with the boss at noon, fast code flow in last chat post.',
        ['Antigravity', 'Neon', 'Sonnet', 'Flash']
      ),
      'Send the saint to sand the rock, tried class with the boss at noon, fast code flow in last chat post.'
    );
    // Standalone common words must not fuzzily turn into Haiku/regex/Flash
    assert.equal(
      runPhonetic('The high shelf holds a cube while the tree needs checks and flush works.'),
      'The high shelf holds a cube while the tree needs checks and flush works.'
    );
    // Non-English mishearings still snap cleanly
    assert.equal(
      runPhonetic('Ask Stoornet, manitija, Mantheja, and Oomachi on Antigravty with Neonn.', [
        'Antigravity',
        'Neon',
      ]),
      'Ask Sonnet, Maniteja, Maniteja, and Omarchy on Antigravity with Neon.'
    );
  });

  it('never turns agent, browser agent, say agent, or say instead into Sonnet or subagent', () => {
    const dictionary = [
      makeDict('d1', 'maniteja', 'Maniteja'),
      makeDict('d2', 'omarchy', 'Omarchy'),
      makeDict('d3', 'sonnet', 'Sonnet'),
      makeDict('d4', 'subagent', 'subagent'),
    ];

    const runPhonetic = (text: string) =>
      runTextPipeline(text, {
        dictionary,
        snippets: [],
        regexRules: [],
        cleanup: makeCleanup(),
      }).finalOutput;

    assert.equal(runPhonetic('Agent.'), 'Agent.');
    assert.equal(runPhonetic('Can you ask the browser agent?'), 'Can you ask the browser agent?');
    assert.equal(runPhonetic("where I'm trying to say agent"), "where I'm trying to say agent");
    assert.equal(runPhonetic("let's say instead"), "let's say instead");
    assert.equal(
      runPhonetic('Ask Stoornet, manitija, Mantheja, Oomachi, and sub-agent.'),
      'Ask Sonnet, Maniteja, Maniteja, Omarchy, and subagent.'
    );
  });
});
