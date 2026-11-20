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
      makeSnippet('s1', 'my calendly', 'https://calendly.com/maniteja/30min\nSee you then!', {
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
      'https://calendly.com/maniteja/30min\nSee you then!'
    );
    assert.equal(
      res.finalOutput,
      'https://calendly.com/maniteja/30min\nSee you then!'
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
      makeSnippet('s-inline', 'sig', 'Best,\nManiteja', { exactOnly: false }),
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
      "I able to go to NYC and NY, but I can't and can’t skip coffee shop, cannot, foo_can, Kubernetes, exact only, Best,\nManiteja."
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
    assert.equal(runStutter('Explain it and blah blah blah.'), 'Explain it and blah blah blah.');
  });
});
