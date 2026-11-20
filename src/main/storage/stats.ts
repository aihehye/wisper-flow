// @ts-ignore Node --experimental-strip-types requires explicit .ts extension
import { BASELINE_TYPING_WPM } from '../../shared/defaults.ts';
import type { HistoryEntry, TokenUsageStats, UsageStats } from '../../shared/types';

function toLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function computeStreakDays(dayKeys: Set<string>, now: Date): number {
  if (dayKeys.size === 0) return 0;

  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const cursor = new Date(todayMidnight);

  if (!dayKeys.has(toLocalDateKey(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
    if (!dayKeys.has(toLocalDateKey(cursor))) {
      return 0;
    }
  }

  let streak = 0;
  while (dayKeys.has(toLocalDateKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

export function computeUsageStats(history: HistoryEntry[]): UsageStats {
  const now = new Date();
  const todayKey = toLocalDateKey(now);
  const activeDays = new Set<string>();

  let totalWords = 0;
  let totalDurationSec = 0;
  let totalSpeechSec = 0;
  let todayWords = 0;

  for (const entry of history) {
    const words = Math.max(0, entry.numWords);
    totalWords += words;
    totalDurationSec += Math.max(0, entry.durationSec);
    totalSpeechSec += Math.max(0, entry.speechDurationSec);

    const parsed = new Date(entry.timestamp);
    if (!Number.isNaN(parsed.getTime())) {
      const key = toLocalDateKey(parsed);
      activeDays.add(key);
      if (key === todayKey) {
        todayWords += words;
      }
    }
  }

  const totalDictations = history.length;
  const averageWpm =
    totalSpeechSec > 0 ? Math.round(totalWords / (totalSpeechSec / 60)) : 0;
  const timeSavedMinutes = Math.max(
    0,
    totalWords / BASELINE_TYPING_WPM - totalDurationSec / 60
  );
  const streakDays = computeStreakDays(activeDays, now);

  return {
    totalWords,
    totalDictations,
    averageWpm,
    streakDays,
    timeSavedMinutes,
    todayWords,
  };
}

function resolveEntryTokens(entry: HistoryEntry): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated: boolean;
} {
  const measuredTotal = Math.max(0, Math.round(entry.totalTokens ?? 0));
  if (measuredTotal > 0) {
    const promptTokens = Math.max(0, Math.round(entry.promptTokens ?? 0));
    const completionTokens = Math.max(0, Math.round(entry.completionTokens ?? 0));
    return {
      promptTokens,
      completionTokens,
      totalTokens: measuredTotal,
      estimated: Boolean(entry.tokensEstimated),
    };
  }

  if (entry.durationSec > 0) {
    const estTotal = Math.max(
      1,
      Math.round(entry.durationSec * 25 + Math.max(0, entry.numWords) * 1.3)
    );
    const estPrompt = Math.round(estTotal * 0.85);
    const estCompletion = Math.max(0, estTotal - estPrompt);
    return {
      promptTokens: estPrompt,
      completionTokens: estCompletion,
      totalTokens: estTotal,
      estimated: true,
    };
  }

  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimated: false,
  };
}

export function getTokenUsageStats(history: HistoryEntry[]): TokenUsageStats {
  const now = new Date();
  const todayKey = toLocalDateKey(now);

  const sevenDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  const sevenDaysCutoff = toLocalDateKey(sevenDaysAgo);

  const dayMap = new Map<
    string,
    { totalTokens: number; promptTokens: number; completionTokens: number; dictations: number }
  >();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    dayMap.set(toLocalDateKey(d), {
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      dictations: 0,
    });
  }

  const allTime = {
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    dictations: history.length,
    measuredDictations: 0,
  };
  const today = { totalTokens: 0, promptTokens: 0, completionTokens: 0, dictations: 0 };
  const last7Days = { totalTokens: 0, promptTokens: 0, completionTokens: 0, dictations: 0 };
  const appMap = new Map<string, { totalTokens: number; dictations: number }>();

  const sortedHistory = [...history].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const recent: TokenUsageStats['recent'] = [];

  for (const entry of sortedHistory) {
    const tokens = resolveEntryTokens(entry);
    allTime.totalTokens += tokens.totalTokens;
    allTime.promptTokens += tokens.promptTokens;
    allTime.completionTokens += tokens.completionTokens;
    if (!tokens.estimated && tokens.totalTokens > 0) {
      allTime.measuredDictations += 1;
    }

    const parsed = new Date(entry.timestamp);
    if (!Number.isNaN(parsed.getTime())) {
      const key = toLocalDateKey(parsed);
      if (key === todayKey) {
        today.totalTokens += tokens.totalTokens;
        today.promptTokens += tokens.promptTokens;
        today.completionTokens += tokens.completionTokens;
        today.dictations += 1;
      }
      if (key >= sevenDaysCutoff) {
        last7Days.totalTokens += tokens.totalTokens;
        last7Days.promptTokens += tokens.promptTokens;
        last7Days.completionTokens += tokens.completionTokens;
        last7Days.dictations += 1;
      }
      const dayBucket = dayMap.get(key);
      if (dayBucket) {
        dayBucket.totalTokens += tokens.totalTokens;
        dayBucket.promptTokens += tokens.promptTokens;
        dayBucket.completionTokens += tokens.completionTokens;
        dayBucket.dictations += 1;
      }
    }

    const appKey = entry.appName?.trim() || 'Unknown';
    const appAgg = appMap.get(appKey) ?? { totalTokens: 0, dictations: 0 };
    appAgg.totalTokens += tokens.totalTokens;
    appAgg.dictations += 1;
    appMap.set(appKey, appAgg);

    if (recent.length < 25) {
      const text = (entry.pastedText || entry.formattedText || entry.asrText || '').trim();
      const textPreview = text.length > 80 ? `${text.slice(0, 77)}...` : text;
      recent.push({
        id: entry.id,
        timestamp: entry.timestamp,
        appName: appKey,
        numWords: entry.numWords,
        promptTokens: tokens.promptTokens,
        completionTokens: tokens.completionTokens,
        totalTokens: tokens.totalTokens,
        estimated: tokens.estimated,
        textPreview,
      });
    }
  }

  const byApp = [...appMap.entries()]
    .map(([appName, agg]) => ({
      appName,
      totalTokens: agg.totalTokens,
      dictations: agg.dictations,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 10);

  const byDay = [...dayMap.entries()].map(([date, agg]) => ({
    date,
    totalTokens: agg.totalTokens,
    promptTokens: agg.promptTokens,
    completionTokens: agg.completionTokens,
    dictations: agg.dictations,
  }));

  return {
    allTime,
    today,
    last7Days,
    byApp,
    byDay,
    recent,
  };
}
