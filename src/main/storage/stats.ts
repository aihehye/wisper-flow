// @ts-ignore Node --experimental-strip-types requires explicit .ts extension
import { BASELINE_TYPING_WPM } from '../../shared/defaults.ts';
import type { HistoryEntry, UsageStats } from '../../shared/types';

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
