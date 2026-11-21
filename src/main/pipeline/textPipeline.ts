// @ts-ignore Node --experimental-strip-types requires explicit .ts extension
import { COMMON_ENGLISH_WORDS } from './typoFixer.ts';
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
  contextTerms?: string[];
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
  `${STUTTER_BOUNDARY_BEFORE}(${WORD_TOKEN}(?:[ \\t]+${WORD_TOKEN}){2,18})(?:(?:[.,!?][ \\t]*|[ \\t]+)\\1)+${STUTTER_BOUNDARY_AFTER}`,
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

const EXTRA_COMMON_SINGLE_WORDS = new Set([
  'newer', 'opens', 'older', 'sized', 'sizes', 'stays', 'timed', 'typed', 'waits', 'wider',
  'winds', 'wings', 'wires', 'pulse', 'snot', 'snout', 'sonata', 'senator',
]);

function isCommonEnglishWord(rawWord: string): boolean {
  const lower = rawWord.toLowerCase();
  if (!lower) return false;
  if (COMMON_ENGLISH_WORDS.has(lower) || EXTRA_COMMON_SINGLE_WORDS.has(lower)) {
    return true;
  }

  // Handle hyphenated common compounds (e.g. "sort-of", "well-known") after exact-match check
  if (lower.includes('-')) {
    const parts = lower.split('-').filter(Boolean);
    if (parts.length >= 2 && parts.every((part) => isCommonEnglishWord(part))) {
      return true;
    }
  }

  // Handle regular English inflections (-s, -es, -ed, -ing, -er, -est, -ly) of common words
  if (lower.length >= 5) {
    if (
      lower.endsWith('s') &&
      !lower.endsWith('ss') &&
      COMMON_ENGLISH_WORDS.has(lower.slice(0, -1))
    ) {
      return true;
    }
    if (lower.endsWith('es') && COMMON_ENGLISH_WORDS.has(lower.slice(0, -2))) {
      return true;
    }
    if (
      lower.endsWith('ed') &&
      (COMMON_ENGLISH_WORDS.has(lower.slice(0, -2)) ||
        COMMON_ENGLISH_WORDS.has(lower.slice(0, -1)))
    ) {
      return true;
    }
    if (
      lower.endsWith('ing') &&
      (COMMON_ENGLISH_WORDS.has(lower.slice(0, -3)) ||
        COMMON_ENGLISH_WORDS.has(`${lower.slice(0, -3)}e`))
    ) {
      return true;
    }
    if (
      lower.endsWith('er') &&
      (COMMON_ENGLISH_WORDS.has(lower.slice(0, -2)) ||
        COMMON_ENGLISH_WORDS.has(lower.slice(0, -1)))
    ) {
      return true;
    }
    if (
      lower.endsWith('est') &&
      (COMMON_ENGLISH_WORDS.has(lower.slice(0, -3)) ||
        COMMON_ENGLISH_WORDS.has(lower.slice(0, -2)))
    ) {
      return true;
    }
    if (lower.endsWith('ly') && COMMON_ENGLISH_WORDS.has(lower.slice(0, -2))) {
      return true;
    }
  }

  return false;
}

interface PhoneticTarget {
  id?: string;
  replacement: string;
  normalized: string;
  skeleton: string;
  wordCount: number;
  firstWordSkeleton: string;
  lastWordSkeleton: string;
  startsWithVowel: boolean;
}

const VOWEL_RE = /[aeiouy]/;

export function toPhoneticSkeleton(raw: string): string {
  let s = raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
  if (!s) return '';

  // Phonetic cluster & voicing normalizations
  s = s
    .replace(/ph/g, 'f')
    .replace(/gh/g, '')
    .replace(/wh/g, 'w')
    .replace(/kn/g, 'n')
    .replace(/wr/g, 'r')
    .replace(/th/g, 't')
    .replace(/ck/g, 'k')
    .replace(/sh/g, 's')
    .replace(/ti(?=[aeiou])/g, 's')
    .replace(/ch/g, 'j')
    .replace(/x/g, 'ks')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/c/g, 'k')
    .replace(/q/g, 'k')
    .replace(/g(?=[eiy])/g, 'j')
    .replace(/z/g, 's')
    .replace(/d/g, 't')
    .replace(/v/g, 'f')
    .replace(/p/g, 'b');

  // Strip vowels & collapse adjacent duplicate consonants/digits
  s = s.replace(/[aeiouy]/g, '').replace(/([a-z0-9])\1+/g, '$1');
  return s;
}

function phoneticSubCost(a: string, b: string): number {
  if (a === b) return 0;
  // Soft fricative / sibilant / affricate / velar confusion pairs in whispered speech
  const pair = a < b ? `${a}${b}` : `${b}${a}`;
  if (
    pair === 'jk' ||
    pair === 'js' ||
    pair === 'ks' ||
    pair === 'gk' ||
    pair === 'bf' ||
    pair === 'ft' ||
    pair === 'lr' ||
    pair === 'mn'
  ) {
    return 0.5;
  }
  return 1;
}

function weightedEditDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Float64Array(n + 1);
  let curr = new Float64Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ai = a[i - 1];
    for (let j = 1; j <= n; j++) {
      const bj = b[j - 1];
      const cost = phoneticSubCost(ai, bj);
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      let best = del < ins ? del : ins;
      if (sub < best) best = sub;
      curr[j] = best;
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  return prev[n];
}

const FUNCTION_LEAD_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'do', 'for', 'from', 'go',
  'has', 'have', 'he', 'hello', 'hey', 'hi', 'his', 'i', 'if', 'in', 'into', 'is', 'it',
  'me', 'my', 'no', 'not', 'of', 'on', 'open', 'or', 'our', 'she', 'so', 'that', 'the',
  'their', 'them', 'then', 'there', 'they', 'this', 'to', 'try', 'up', 'use', 'was',
  'we', 'were', 'what', 'when', 'who', 'will', 'with', 'you', 'your',
]);

const FUNCTION_TRAIL_WORDS = new Set([
  'a', 'about', 'after', 'all', 'also', 'an', 'and', 'any', 'are', 'as', 'at', 'back', 'be',
  'before', 'but', 'by', 'can', 'could', 'did', 'do', 'down', 'for', 'from', 'had', 'has',
  'have', 'he', 'her', 'here', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
  'just', 'me', 'more', 'most', 'my', 'no', 'not', 'now', 'of', 'off', 'on', 'one', 'only',
  'onto', 'or', 'our', 'out', 'over', 'she', 'should', 'so', 'some', 'than', 'that', 'the',
  'their', 'them', 'then', 'there', 'they', 'this', 'to', 'too', 'under', 'up', 'us', 'very',
  'was', 'we', 'were', 'what', 'when', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
]);

function scorePhoneticMatch(
  spanWords: string[],
  target: PhoneticTarget
): number {
  // Never fuzzy-match code identifiers containing underscores
  if (spanWords.some((w) => w.includes('_'))) return 0;

  const spanRaw = spanWords.join(' ');
  const spanNorm = spanRaw.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!spanNorm || spanNorm.length < 4) return 0;

  // Already exact case-insensitive match -> snap casing directly
  if (spanNorm === target.normalized) {
    return spanRaw === target.replacement ? 0 : 1.0;
  }

  // Reject single common English words from fuzzy replacement unless exact normalized match
  if (spanWords.length === 1 && isCommonEnglishWord(spanWords[0])) {
    return 0;
  }

  // Never let a 2-word span start or end with a common function/greeting word unless the target itself matches that edge word
  if (spanWords.length >= 2) {
    const targetParts = target.replacement.split(/[\s-]+/).filter(Boolean);
    const leadLower = spanWords[0].toLowerCase();
    const targetLead = targetParts[0]?.toLowerCase() ?? '';
    if (FUNCTION_LEAD_WORDS.has(leadLower) && leadLower !== targetLead) {
      return 0;
    }
    const trailLower = spanWords[spanWords.length - 1].toLowerCase();
    const targetTrail = targetParts[targetParts.length - 1]?.toLowerCase() ?? '';
    if (FUNCTION_TRAIL_WORDS.has(trailLower) && trailLower !== targetTrail) {
      return 0;
    }
  }

  const spanSkel = toPhoneticSkeleton(spanRaw);
  const tgtSkel = target.skeleton;
  if (!spanSkel || !tgtSkel) return 0;

  // 1-consonant proper nouns (e.g. "Neon" -> skeleton "n"): only allow exact skeleton + raw edit distance <= 1
  if (tgtSkel.length < 2) {
    if (spanSkel !== tgtSkel) return 0;
    const rawDist = weightedEditDistance(spanNorm, target.normalized);
    return rawDist <= 1 ? 0.92 : 0;
  }
  if (spanSkel.length < 2) return 0;

  // Length ratio sanity check
  const maxNormLen = Math.max(spanNorm.length, target.normalized.length);
  const minNormLen = Math.min(spanNorm.length, target.normalized.length);
  if (minNormLen / maxNormLen < 0.45) return 0;

  const maxSkelLen = Math.max(spanSkel.length, tgtSkel.length);
  if (Math.abs(spanSkel.length - tgtSkel.length) > Math.max(2, Math.floor(maxSkelLen * 0.45))) {
    return 0;
  }

  const skelDist = weightedEditDistance(spanSkel, tgtSkel);
  const skelSim = 1 - skelDist / maxSkelLen;

  // Exact consonant skeleton match
  if (skelDist === 0) {
    if (tgtSkel.length <= 2) {
      const rawDist = weightedEditDistance(spanNorm, target.normalized);
      if (rawDist > 2) return 0;
    }
    return 0.96;
  }

  // Multi-word target where first OR last word is already a phonetic hit
  // (e.g. "whisper flower" -> "Wisper Flow", "traffic card" -> "graphics card")
  if (target.wordCount >= 2 && spanWords.length >= 2) {
    const firstSkel = toPhoneticSkeleton(spanWords[0]);
    if (firstSkel && firstSkel === target.firstWordSkeleton && skelSim >= 0.65) {
      return Math.min(0.95, skelSim + 0.12);
    }
    const lastSkel = toPhoneticSkeleton(spanWords[spanWords.length - 1]);
    if (lastSkel && lastSkel === target.lastWordSkeleton && skelSim >= 0.6) {
      return Math.min(0.95, skelSim + 0.15);
    }
  }

  // Do not let a single word expand into a multi-word target unless its consonant skeleton is identical
  // (prevents "able" inside "able to" from re-expanding to "able to to").
  if (target.wordCount >= 2 && spanWords.length === 1) {
    const firstWordLower = target.replacement.split(/[\s-]+/)[0]?.toLowerCase() ?? '';
    if (spanWords[0].toLowerCase() === firstWordLower) {
      return 0;
    }
  }

  // High consonant-skeleton similarity with edge/vowel-class confirmation
  const spanStartsVowel = VOWEL_RE.test(spanNorm[0] ?? '');
  const startsSame =
    spanSkel[0] === tgtSkel[0] ||
    (spanStartsVowel && target.startsWithVowel && spanNorm[0] === target.normalized[0]);
  const endsSame =
    spanSkel[spanSkel.length - 1] === tgtSkel[tgtSkel.length - 1] ||
    spanNorm.slice(-2) === target.normalized.slice(-2);

  if (skelSim >= 0.72 && startsSame && endsSame) {
    return skelSim;
  }

  if (skelSim >= 0.75 && (startsSame || endsSame)) {
    return skelSim;
  }

  // Slightly looser threshold for 1-edit short skeletons (e.g. "Oomachi" -> "Omarchy", "high cube" -> "Haiku")
  if (skelDist <= 1 && startsSame && spanSkel.length >= 2 && tgtSkel.length >= 2) {
    const cleanSpan = spanNorm.replace(/gh/g, '');
    const cleanTgt = target.normalized.replace(/gh/g, '');
    const cleanMax = Math.max(cleanSpan.length, cleanTgt.length);
    const rawSim = 1 - weightedEditDistance(cleanSpan, cleanTgt) / cleanMax;
    if (rawSim >= 0.45 || (spanWords.length >= 2 && spanSkel.startsWith(tgtSkel))) {
      return 0.76;
    }
  }

  // Longer / multi-word phonetic approximations (e.g. "Stoornet" -> "Sonnet", "such patient" -> "subagent")
  if (skelSim >= 0.6 && startsSame && endsSame) {
    const rawSim = 1 - weightedEditDistance(spanNorm, target.normalized) / maxNormLen;
    if (rawSim >= 0.45) {
      return 0.74;
    }
  }

  // 2-word phonetic mishearing of a 1-word technical term where leading consonant shifts (e.g. "tree checks" -> "regex")
  if (
    spanWords.length >= 2 &&
    skelSim >= 0.6 &&
    endsSame &&
    spanSkel.length >= 4 &&
    tgtSkel.length >= 4 &&
    spanSkel.slice(0, 2).includes(tgtSkel[0])
  ) {
    const rawSim = 1 - weightedEditDistance(spanNorm, target.normalized) / maxNormLen;
    if (rawSim >= 0.35) {
      return 0.73;
    }
  }

  return 0;
}

function applyPhoneticDictionaryMatching(
  text: string,
  dictionary: DictionaryEntry[],
  contextTerms: string[] | undefined,
  matchedDictionaryIds: Set<string>
): string {
  const targets: PhoneticTarget[] = [];
  const seenTargets = new Set<string>();

  const addTarget = (raw: string, id?: string, minLen = 5) => {
    const replacement = raw.trim();
    if (!replacement) return;
    const normalized = replacement.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalized.length < minLen) return;
    if (seenTargets.has(normalized)) return;
    const skeleton = toPhoneticSkeleton(replacement);
    if (skeleton.length < 1) return;
    seenTargets.add(normalized);
    const words = replacement.split(/[\s-]+/).filter(Boolean);
    targets.push({
      id,
      replacement,
      normalized,
      skeleton,
      wordCount: words.length,
      firstWordSkeleton: words.length > 0 ? toPhoneticSkeleton(words[0]) : skeleton,
      lastWordSkeleton: words.length > 0 ? toPhoneticSkeleton(words[words.length - 1]) : skeleton,
      startsWithVowel: VOWEL_RE.test(normalized[0] ?? ''),
    });
  };

  for (const entry of dictionary) {
    if (!entry.enabled) continue;
    const targetWord = entry.replacement?.trim() || entry.phrase.trim();
    addTarget(targetWord, entry.id, 5);
  }

  if (contextTerms) {
    for (const term of contextTerms) {
      addTarget(term, undefined, 4);
    }
  }

  if (targets.length === 0) return text;

  // Tokenize preserving exact character offsets so punctuation & whitespace remain intact.
  interface SpanToken {
    raw: string;
    core: string;
    lead: string;
    trail: string;
    start: number;
    end: number;
  }

  const tokens: SpanToken[] = [];
  const tokenRe = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text)) !== null) {
    const raw = m[0];
    const leadMatch = raw.match(/^[^\p{L}\p{N}]+/u);
    const trailMatch = raw.match(/[^\p{L}\p{N}]+$/u);
    const lead = leadMatch ? leadMatch[0] : '';
    const trail = trailMatch && trailMatch[0].length < raw.length - lead.length ? trailMatch[0] : '';
    const core = raw.slice(lead.length, raw.length - trail.length);
    tokens.push({
      raw,
      core,
      lead,
      trail,
      start: m.index,
      end: m.index + raw.length,
    });
  }

  if (tokens.length === 0) return text;

  let out = '';
  let cursor = 0;
  let i = 0;

  while (i < tokens.length) {
    let bestTarget: PhoneticTarget | null = null;
    let bestScore = 0;
    let bestSpanLen = 1;

    // Try 2-word spans first (handles "D3 code" -> "T3Code", "baller plate" -> "boilerplate", "whisper flower" -> "Wisper Flow")
    // only if there is no hard sentence punctuation between the two tokens.
    if (
      i + 1 < tokens.length &&
      tokens[i].core.length > 0 &&
      tokens[i + 1].core.length > 0 &&
      !/[.!?;:\n]/.test(tokens[i].trail) &&
      !/[\r\n]/.test(text.slice(tokens[i].end, tokens[i + 1].start))
    ) {
      const twoWords = [tokens[i].core, tokens[i + 1].core];
      for (const tgt of targets) {
        const score = scorePhoneticMatch(twoWords, tgt);
        if (score > bestScore) {
          // Do not swallow tokens[i] if tokens[i + 1] alone is already a stronger match for tgt
          const secondAlone = scorePhoneticMatch([tokens[i + 1].core], tgt);
          if (secondAlone >= score) continue;
          bestScore = score;
          bestTarget = tgt;
          bestSpanLen = 2;
        }
      }
    }

    // Try 1-word span (also handles hyphenated tokens like "sub-agent")
    if (tokens[i].core.length > 0) {
      const oneWord = [tokens[i].core];
      for (const tgt of targets) {
        const score = scorePhoneticMatch(oneWord, tgt);
        // Prefer exact 1-word hit over 2-word fuzzy hit if stronger
        if (score > bestScore) {
          bestScore = score;
          bestTarget = tgt;
          bestSpanLen = 1;
        }
      }
    }

    if (bestTarget && bestScore >= 0.72) {
      const firstTok = tokens[i];
      const lastTok = tokens[i + bestSpanLen - 1];
      out += text.slice(cursor, firstTok.start);
      out += `${firstTok.lead}${bestTarget.replacement}${lastTok.trail}`;
      cursor = lastTok.end;
      if (bestTarget.id) {
        matchedDictionaryIds.add(bestTarget.id);
      }
      i += bestSpanLen;
    } else {
      i += 1;
    }
  }

  out += text.slice(cursor);
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

    // Step 3b: Vowel-stripped consonant-skeleton phonetic fuzzy matcher for Dictionary targets & active window context.
    afterDictionaryAndInlineSnippets = applyPhoneticDictionaryMatching(
      afterDictionaryAndInlineSnippets,
      opts.dictionary,
      opts.contextTerms,
      matchedDictionaryIds
    );
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
