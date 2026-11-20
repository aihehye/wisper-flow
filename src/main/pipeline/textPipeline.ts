import type {
  CleanupOptions,
  DictionaryEntry,
  PipelineTrace,
  RegexRuleEntry,
  SnippetEntry,
} from '../../shared/types';

export interface TextPipelineOptions {
  dictionary: DictionaryEntry[];
  snippets: SnippetEntry[];
  regexRules: RegexRuleEntry[];
  cleanup: CleanupOptions;
  targetAppName?: string;
}

interface InlineRule {
  kind: 'dictionary' | 'snippet';
  id: string;
  term: string;
  replacement: string;
}

const ALLOWED_REGEX_FLAGS = new Set(['g', 'i', 'm', 'u']);
const FILLER_CORE = '(?:um+|uh+|er+|ah+|hmm+)';
const FILLER_BOUNDED = `(?<![\\p{L}\\p{N}_-])${FILLER_CORE}(?![\\p{L}\\p{N}_-])`;
const WORD_TOKEN = "\\p{L}+(?:['’]\\p{L}+)?";
const STUTTER_BOUNDARY_BEFORE = "(?<![\\p{L}\\p{N}_'’-])";
const STUTTER_BOUNDARY_AFTER = "(?![\\p{L}\\p{N}_'’-])";
const STUTTER_SINGLE_RE = new RegExp(
  `${STUTTER_BOUNDARY_BEFORE}(${WORD_TOKEN})(?:(?:,[ \\t]*|[ \\t]+)\\1)+${STUTTER_BOUNDARY_AFTER}`,
  'giu'
);
const STUTTER_PAIR_RE = new RegExp(
  `${STUTTER_BOUNDARY_BEFORE}(${WORD_TOKEN}[ \\t]+${WORD_TOKEN})(?:(?:,[ \\t]*|[ \\t]+)\\1)+${STUTTER_BOUNDARY_AFTER}`,
  'giu'
);
const STUTTER_PHRASE_RE = new RegExp(
  `${STUTTER_BOUNDARY_BEFORE}(${WORD_TOKEN}(?:[ \\t]+${WORD_TOKEN}){2,5})(?:(?:[.,][ \\t]*|[ \\t]+)\\1)+${STUTTER_BOUNDARY_AFTER}`,
  'giu'
);
const STUTTER_IDIOM_ALLOWLIST = new Set(['blah']);

function isAllowlistedStutter(phrase: string): boolean {
  const words = phrase.trim().toLowerCase().split(/\s+/);
  return words.length > 0 && words.every((w) => STUTTER_IDIOM_ALLOWLIST.has(w));
}

function collapseStutterMatch(match: string, phrase: string): string {
  return isAllowlistedStutter(phrase) ? match : phrase;
}

export function collapseSpokenStutters(text: string): string {
  // Collapse 1-word, 2-word, and 3-6 word phrase repetition loops while preserving allowlisted idioms.
  return text
    .replace(STUTTER_SINGLE_RE, collapseStutterMatch)
    .replace(STUTTER_PAIR_RE, collapseStutterMatch)
    .replace(STUTTER_PHRASE_RE, collapseStutterMatch);
}

function escapeRegexLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeForExactSnippet(text: string): string {
  return text
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function sanitizeRegexFlags(flags: string): string {
  const seen = new Set<string>();
  let result = '';
  for (const ch of flags) {
    if (ALLOWED_REGEX_FLAGS.has(ch) && !seen.has(ch)) {
      seen.add(ch);
      result += ch;
    }
  }
  return result;
}

function unescapeReplacement(replacement: string): string {
  return replacement.replace(/\\([nrt\\])/g, (_, esc: string) => {
    switch (esc) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case '\\':
        return '\\';
      default:
        return esc;
    }
  });
}

function stripExeSuffix(name: string): string {
  return name.trim().toLowerCase().replace(/\.exe$/i, '');
}

function applyDeterministicCleanup(
  input: string,
  cleanup: CleanupOptions,
  targetAppName?: string
): string {
  let out = input;

  if (cleanup.stripExtraFillers) {
    // Preserve sentence capitalization when removing a sentence-leading filler before a lowercase word.
    const leadingSentenceFiller = new RegExp(
      `(^|[.!?]\\s+|\\n\\s*)${FILLER_BOUNDED}(?:,\\s*|\\s+)(\\p{Ll})`,
      'giu'
    );
    out = out.replace(
      leadingSentenceFiller,
      (_, prefix: string, nextChar: string) => `${prefix}${nextChar.toUpperCase()}`
    );

    // Remove comma-prefixed filler before terminal punctuation or end of string.
    const trailingCommaFiller = new RegExp(
      `,\\s*${FILLER_BOUNDED}(?=$|[.!?;:])`,
      'giu'
    );
    out = out.replace(trailingCommaFiller, '');

    // Collapse ", filler," into a single comma.
    const wrappedCommaFiller = new RegExp(`,\\s*${FILLER_BOUNDED}\\s*,`, 'giu');
    out = out.replace(wrappedCommaFiller, ',');

    // Remove remaining standalone fillers with optional trailing comma/horizontal space.
    const remainingFiller = new RegExp(`${FILLER_BOUNDED}[ \\t]*,?`, 'giu');
    out = out.replace(remainingFiller, '');

    out = out
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+([,.!?;:])/g, '$1')
      .trim();

    out = collapseSpokenStutters(out);
  }

  if (cleanup.spokenFormatting) {
    out = out
      .replace(/[ \t]*,?[ \t]*\bnew paragraph\b[ \t]*[,.]?[ \t]*/gi, '\n\n')
      .replace(/[ \t]*,?[ \t]*\bnew line\b[ \t]*[,.]?[ \t]*/gi, '\n')
      .replace(/[ \t]*,?[ \t]*\bbullet point\b[ \t]*[:,.]?[ \t]*/gi, '\n- ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\n+/, '');
  }

  if (cleanup.normalizeSpacing) {
    out = out
      .replace(/[ \t]+/g, ' ')
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/[ \t]+([,.!?;:])/g, '$1')
      .replace(/([!?;])(?=[\p{L}\p{N}])/gu, '$1 ')
      .replace(/(?<!\d)([,:])(?=[\p{L}\p{N}])|(?<=\d)([,:])(?=\p{L})/gu, (match) => `${match} `)
      .replace(/(?<=[\p{Ll}\p{N}])\.(?=\p{Lu})/gu, '. ')
      .trim();
  }

  const targetNormalized = stripExeSuffix(targetAppName ?? '');
  const matchesLowercaseApp =
    targetNormalized.length > 0 &&
    cleanup.allLowercaseApps.some((app) => {
      const candidate = stripExeSuffix(app);
      return candidate.length > 0 && candidate === targetNormalized;
    });

  if (cleanup.allLowercaseGlobal || matchesLowercaseApp) {
    out = out.toLowerCase();
  }

  return out;
}

export function validateRegexPattern(
  pattern: string,
  flags: string
): { valid: boolean; error?: string } {
  try {
    new RegExp(pattern, sanitizeRegexFlags(flags));
    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function runTextPipeline(
  rawAsrText: string,
  opts: TextPipelineOptions
): PipelineTrace {
  // Step 1: Strip any stray `language <Name><asr_text>` prefix and trim outer whitespace.
  const afterPrefixStrip = rawAsrText
    .replace(/^\s*(?:language\s+[^\r\n<]+?)?<asr_text>/iu, '')
    .trim();

  // Step 2: Full-utterance exact snippet match (punctuation/symbol/case insensitive).
  let matchedExactSnippetId: string | undefined;
  let afterExactSnippet = afterPrefixStrip;
  const matchedDictionaryIds = new Set<string>();
  const matchedSnippetIds = new Set<string>();
  const appliedRegexRuleIds: string[] = [];

  const normalizedTranscript = normalizeForExactSnippet(afterPrefixStrip);
  if (normalizedTranscript.length > 0) {
    const enabledSnippets = opts.snippets.filter((s) => s.enabled);
    const exactMatch = enabledSnippets.find(
      (s) => normalizeForExactSnippet(s.trigger) === normalizedTranscript
    );
    if (exactMatch) {
      matchedExactSnippetId = exactMatch.id;
      matchedSnippetIds.add(exactMatch.id);
      afterExactSnippet = exactMatch.expansion;
    }
  }

  // Step 3: Longest-first Dictionary replacement + inline Snippets (skipped if exact snippet matched).
  let afterDictionaryAndInlineSnippets = afterExactSnippet;
  if (!matchedExactSnippetId && afterExactSnippet.length > 0) {
    const inlineRules: InlineRule[] = [];

    for (const dict of opts.dictionary) {
      if (!dict.enabled || dict.replacement === null || dict.replacement === '') continue;
      const term = dict.phrase.trim();
      if (!term) continue;
      inlineRules.push({
        kind: 'dictionary',
        id: dict.id,
        term,
        replacement: dict.replacement,
      });
    }

    for (const snippet of opts.snippets) {
      if (!snippet.enabled || snippet.exactOnly) continue;
      const term = snippet.trigger.trim();
      if (!term) continue;
      inlineRules.push({
        kind: 'snippet',
        id: snippet.id,
        term,
        replacement: snippet.expansion,
      });
    }

    inlineRules.sort((a, b) => b.term.length - a.term.length);

    const ruleByLower = new Map<string, InlineRule>();
    const escapedTerms: string[] = [];
    for (const rule of inlineRules) {
      const key = rule.term.toLowerCase();
      if (ruleByLower.has(key)) continue;
      ruleByLower.set(key, rule);
      escapedTerms.push(escapeRegexLiteral(rule.term));
    }

    if (escapedTerms.length > 0) {
      const combinedPattern = `(?<![\\p{L}\\p{N}_])(?:${escapedTerms.join('|')})(?![\\p{L}\\p{N}_])(?!['‘’´\`′]t(?![\\p{L}\\p{N}]))`;
      const combinedRegex = new RegExp(combinedPattern, 'giu');
      afterDictionaryAndInlineSnippets = afterExactSnippet.replace(combinedRegex, (match) => {
        const rule = ruleByLower.get(match.toLowerCase());
        if (!rule) return match;
        if (rule.kind === 'dictionary') {
          matchedDictionaryIds.add(rule.id);
        } else {
          matchedSnippetIds.add(rule.id);
        }
        return rule.replacement;
      });
    }
  }

  // Step 4: Ordered user Regex Rules.
  let afterRegexRules = afterDictionaryAndInlineSnippets;
  const sortedRules = [...opts.regexRules]
    .filter((r) => r.enabled && r.pattern.length > 0)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  for (const rule of sortedRules) {
    try {
      const flags = sanitizeRegexFlags(rule.flags);
      const regex = new RegExp(rule.pattern, flags);
      if (regex.test(afterRegexRules)) {
        regex.lastIndex = 0;
        const replacement = unescapeReplacement(rule.replacement);
        afterRegexRules = afterRegexRules.replace(regex, replacement);
        appliedRegexRuleIds.push(rule.id);
      }
    } catch {
      // Invalid user regex must never crash dictation.
    }
  }

  // Step 5: Deterministic cleanup (skipped if exact snippet matched to preserve templates/URLs verbatim).
  const finalOutput = matchedExactSnippetId
    ? afterRegexRules
    : applyDeterministicCleanup(afterRegexRules, opts.cleanup, opts.targetAppName);

  return {
    input: rawAsrText,
    afterPrefixStrip,
    afterExactSnippet,
    afterDictionaryAndInlineSnippets,
    afterRegexRules,
    finalOutput,
    matchedExactSnippetId,
    matchedDictionaryIds: [...matchedDictionaryIds],
    matchedSnippetIds: [...matchedSnippetIds],
    appliedRegexRuleIds,
  };
}
