import type { FocusedTextResult } from '../platform/types';

export interface CorrectionCandidate {
  phrase: string;
  replacement: string;
}

export interface CorrectionWatchEvent extends CorrectionCandidate {
  appName: string;
}

export interface CorrectionWatchTextEvent {
  historyId?: string;
  correctedText: string;
  appName: string;
}

export interface CorrectionWatchOptions {
  pastedText: string;
  historyId?: string;
  targetAppName?: string;
  targetWindowTitle?: string;
  readFocusedText?: () => Promise<FocusedTextResult>;
  pollDelaysMs?: number[];
  onCorrectedText?: (event: CorrectionWatchTextEvent) => void;
}

type FocusedTextReader = () => Promise<FocusedTextResult>;

let registeredReader: FocusedTextReader | null = null;
let activeWatchCancel: (() => void) | null = null;

const DEFAULT_POLL_DELAYS_MS = [3000, 5000, 7000, 9000, 11000];
const MAX_CHANGED_WORDS = 3;

/**
 * Registers the platform-specific focused-text reader (e.g. WindowsBridge).
 */
export function setFocusedTextReader(reader: FocusedTextReader | null): void {
  registeredReader = reader;
}

interface WordToken {
  word: string;
  lower: string;
  rawStart: number;
  rawEnd: number;
}

const EDGE_PUNCTUATION_RE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const HAS_ALNUM_RE = /[\p{L}\p{N}]/u;

function tokenizeWords(text: string): WordToken[] {
  const tokens: WordToken[] = [];
  const re = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const part = match[0];
    const stripped = part.replace(EDGE_PUNCTUATION_RE, '');
    if (!stripped || !HAS_ALNUM_RE.test(stripped)) continue;
    tokens.push({
      word: stripped,
      lower: stripped.toLowerCase(),
      rawStart: match.index,
      rawEnd: match.index + part.length,
    });
  }
  return tokens;
}

function bigramSimilarity(a: string, b: string): number {
  const s1 = a.toLowerCase();
  const s2 = b.toLowerCase();
  if (s1 === s2) return 1;
  if (s1.length < 2 || s2.length < 2) return s1 === s2 ? 1 : 0;
  const bigrams1 = new Map<string, number>();
  for (let i = 0; i < s1.length - 1; i++) {
    const bg = s1.slice(i, i + 2);
    bigrams1.set(bg, (bigrams1.get(bg) ?? 0) + 1);
  }
  let intersection = 0;
  for (let i = 0; i < s2.length - 1; i++) {
    const bg = s2.slice(i, i + 2);
    const count = bigrams1.get(bg) ?? 0;
    if (count > 0) {
      intersection++;
      bigrams1.set(bg, count - 1);
    }
  }
  return (2 * intersection) / (s1.length - 1 + (s2.length - 1));
}

function lcsMatches(
  a: WordToken[],
  b: WordToken[],
  caseInsensitive: boolean
): Array<[number, number]> {
  const m = a.length;
  const n = b.length;
  // Guard against unexpectedly huge token arrays
  if (m === 0 || n === 0 || m * n > 2_000_000) return [];

  const dp = new Uint16Array((m + 1) * (n + 1));
  const stride = n + 1;

  for (let i = m - 1; i >= 0; i--) {
    const ai = caseInsensitive ? a[i].lower : a[i].word;
    const row = i * stride;
    const nextRow = (i + 1) * stride;
    for (let j = n - 1; j >= 0; j--) {
      const bj = caseInsensitive ? b[j].lower : b[j].word;
      if (ai === bj) {
        dp[row + j] = dp[nextRow + j + 1] + 1;
      } else {
        const down = dp[nextRow + j];
        const right = dp[row + j + 1];
        dp[row + j] = down >= right ? down : right;
      }
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    const ai = caseInsensitive ? a[i].lower : a[i].word;
    const bj = caseInsensitive ? b[j].lower : b[j].word;
    if (ai === bj) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[(i + 1) * stride + j] >= dp[i * stride + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

function locateRegion(pTokens: WordToken[], eTokens: WordToken[]): WordToken[] | null {
  const m = pTokens.length;
  const n = eTokens.length;
  if (m === 0 || n === 0) return null;

  // Short paste into short field: compare directly if lengths are compatible
  if (m <= 3 && n <= m + 2) {
    const pairs = lcsMatches(pTokens, eTokens, true);
    if (pairs.length >= 1) return eTokens;
    const pJoined = pTokens.map((t) => t.lower).join('');
    const eJoined = eTokens.map((t) => t.lower).join('');
    if (bigramSimilarity(pJoined, eJoined) >= 0.45) {
      return eTokens;
    }
    return null;
  }

  // Collect candidate start indices in eTokens using 1-2 word anchors from pTokens
  const candidateStarts = new Set<number>();
  if (n <= m + 4) {
    candidateStarts.add(0);
  }

  const indexByWord = new Map<string, number[]>();
  for (let j = 0; j < n; j++) {
    const key = eTokens[j].lower;
    let list = indexByWord.get(key);
    if (!list) {
      list = [];
      indexByWord.set(key, list);
    }
    if (list.length < 32) list.push(j);
  }

  // Sample anchor offsets across pTokens (start, end, and a few middle positions)
  const offsets = new Set<number>([0, Math.max(0, m - 1), Math.max(0, m - 2), Math.floor(m / 2)]);
  for (const pIdx of offsets) {
    const hits = indexByWord.get(pTokens[pIdx].lower);
    if (!hits) continue;
    for (const eIdx of hits) {
      candidateStarts.add(Math.max(0, eIdx - pIdx));
      if (pIdx > 0) {
        candidateStarts.add(Math.max(0, eIdx - pIdx - 1));
      }
    }
  }

  let bestScore = -1;
  let bestWindow: WordToken[] | null = null;
  let bestPairs: Array<[number, number]> = [];

  for (const start of candidateStarts) {
    const end = Math.min(n, start + m + 4);
    if (end <= start) continue;
    const window = eTokens.slice(start, end);
    const pairs = lcsMatches(pTokens, window, true);
    if (pairs.length > bestScore) {
      bestScore = pairs.length;
      bestWindow = window;
      bestPairs = pairs;
    }
  }

  if (!bestWindow || bestPairs.length === 0) return null;

  const minRequired = m <= 3 ? 1 : Math.max(2, Math.ceil(m * 0.45));
  if (bestScore < minRequired) return null;

  // Trim extraneous leading/trailing tokens outside the pasted span
  const [firstP, firstE] = bestPairs[0];
  const [lastP, lastE] = bestPairs[bestPairs.length - 1];

  const trimStart = firstP === 0 ? firstE : Math.max(0, firstE - firstP);
  const remainingTail = m - 1 - lastP;
  const trimEnd =
    remainingTail === 0 ? lastE + 1 : Math.min(bestWindow.length, lastE + 1 + remainingTail);

  if (trimEnd <= trimStart) return null;
  return bestWindow.slice(trimStart, trimEnd);
}

/**
 * Extracts 1-to-3 word correction candidates by locating `pastedText` inside
 * `editedText` and diffing word tokens.
 */
export function extractCorrectionCandidates(
  pastedText: string,
  editedText: string
): CorrectionCandidate[] {
  if (!pastedText || !editedText || pastedText === editedText) return [];

  const pTokens = tokenizeWords(pastedText);
  const eTokens = tokenizeWords(editedText);
  if (pTokens.length === 0 || eTokens.length === 0) return [];

  const region = locateRegion(pTokens, eTokens);
  if (!region || region.length === 0) {
    if (
      pTokens.length >= 1 &&
      pTokens.length <= MAX_CHANGED_WORDS &&
      eTokens.length >= 1 &&
      eTokens.length <= MAX_CHANGED_WORDS
    ) {
      const phrase = pTokens.map((t) => t.word).join(' ');
      const replacement = eTokens.map((t) => t.word).join(' ');
      if (phrase && replacement && phrase !== replacement) {
        return [{ phrase, replacement }];
      }
    }
    return [];
  }

  // Exact-case LCS on the located region so case fixes ("whisper flow" -> "Wisper Flow") are captured
  const pairs = lcsMatches(pTokens, region, false);
  const candidates: CorrectionCandidate[] = [];

  let prevP = -1;
  let prevE = -1;

  const sentinelPairs: Array<[number, number]> = [...pairs, [pTokens.length, region.length]];

  for (const [curP, curE] of sentinelPairs) {
    const pLen = curP - prevP - 1;
    const eLen = curE - prevE - 1;

    if (pLen >= 1 && pLen <= MAX_CHANGED_WORDS && eLen >= 1 && eLen <= MAX_CHANGED_WORDS) {
      const phrase = pTokens
        .slice(prevP + 1, curP)
        .map((t) => t.word)
        .join(' ');
      const replacement = region
        .slice(prevE + 1, curE)
        .map((t) => t.word)
        .join(' ');

      if (phrase && replacement && phrase !== replacement) {
        candidates.push({ phrase, replacement });
      }
    }

    prevP = curP;
    prevE = curE;
  }

  return candidates;
}

/**
 * Extracts the corrected span corresponding to `pastedText` inside `editedText`
 * with original punctuation and casing preserved.
 */
export function extractCorrectedFullText(pastedText: string, editedText: string): string | null {
  if (!pastedText || !editedText || pastedText === editedText) return null;
  const pTokens = tokenizeWords(pastedText);
  const eTokens = tokenizeWords(editedText);
  if (pTokens.length === 0 || eTokens.length === 0) return null;

  const region = locateRegion(pTokens, eTokens);
  if (!region || region.length === 0) {
    if (
      pTokens.length <= MAX_CHANGED_WORDS &&
      eTokens.length <= MAX_CHANGED_WORDS
    ) {
      return editedText.trim() || null;
    }
    return null;
  }

  const start = region[0].rawStart;
  const end = region[region.length - 1].rawEnd;
  const slice = editedText.slice(start, end).trim();
  return slice || null;
}

/**
 * Polls the focused UI control on Windows after pasting to detect manual user
 * corrections and emit candidate dictionary entries.
 * Cancels any prior active watch when called again.
 */
export function scheduleCorrectionWatch(
  opts: CorrectionWatchOptions,
  onCandidate: (c: CorrectionWatchEvent) => void
): () => void {
  if (activeWatchCancel) {
    activeWatchCancel();
    activeWatchCancel = null;
  }

  const reader = opts.readFocusedText ?? registeredReader;
  if (!opts.readFocusedText && process.platform !== 'win32') {
    return () => {};
  }
  if (!reader || !opts.pastedText.trim()) {
    return () => {};
  }

  const delays = opts.pollDelaysMs?.length ? opts.pollDelaysMs : DEFAULT_POLL_DELAYS_MS;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastText: string | null = null;
  const startedAt = Date.now();

  const cancel = () => {
    cancelled = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (activeWatchCancel === cancel) {
      activeWatchCancel = null;
    }
  };

  activeWatchCancel = cancel;

  const targetApp = opts.targetAppName?.trim().toLowerCase() || '';

  const scheduleStep = (stepIndex: number) => {
    if (cancelled || stepIndex >= delays.length) {
      cancel();
      return;
    }

    const elapsed = Date.now() - startedAt;
    const waitMs = Math.max(0, delays[stepIndex] - elapsed);

    timer = setTimeout(async () => {
      timer = null;
      if (cancelled) return;

      let res: FocusedTextResult;
      try {
        res = await reader();
      } catch {
        scheduleStep(stepIndex + 1);
        return;
      }

      if (cancelled) return;

      if (res.reason === 'password') {
        cancel();
        return;
      }

      const currentApp = res.processName?.trim().toLowerCase() || '';
      if (targetApp && currentApp && currentApp !== targetApp) {
        cancel();
        return;
      }

      if (res.ok && typeof res.text === 'string') {
        if (lastText === null || res.text !== lastText) {
          lastText = res.text;
        } else {
          const candidates = extractCorrectionCandidates(opts.pastedText, res.text);
          if (candidates.length > 0) {
            const appName = res.processName || opts.targetAppName || '';
            const correctedText = extractCorrectedFullText(opts.pastedText, res.text);
            cancel();
            if (correctedText) {
              opts.onCorrectedText?.({
                historyId: opts.historyId,
                correctedText,
                appName,
              });
            }
            for (const c of candidates) {
              onCandidate({
                phrase: c.phrase,
                replacement: c.replacement,
                appName,
              });
            }
            return;
          }
        }
      }

      scheduleStep(stepIndex + 1);
    }, waitMs);

    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref?: () => void }).unref?.();
    }
  };

  scheduleStep(0);
  return cancel;
}
