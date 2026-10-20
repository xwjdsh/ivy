// Past conversations as a timeline: under the day they were last active, oldest first, the
// way a long conversation with someone reads when you scroll back.

import type { SessionSummary } from "@ivy/protocol";

export interface Day {
  label: string;
  sessions: SessionSummary[];
}

/**
 * A conversation last active this long ago is carried on when the window opens; an older one
 * is history, and the window starts a new one.
 */
export const CARRY_ON_MS = 6 * 60 * 60 * 1000;

export const isRecent = (s: SessionSummary, now = Date.now()) =>
  now - Date.parse(s.updatedAt) < CARRY_ON_MS;

const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "Today", "Yesterday", a weekday within the week, else a date ("Oct 12", "Oct 12, 2025"). */
export function dayLabel(date: Date, now = new Date()): string {
  const days = Math.round((midnight(now) - midnight(date)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return date.toLocaleDateString("en-US", { weekday: "long" });
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

/** "18:02" */
export const timeLabel = (date: Date) =>
  `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;

/** Sessions, newest first as the daemon lists them, grouped by day, oldest day first. */
export function byDay(sessions: SessionSummary[], now = new Date()): Day[] {
  const days: Day[] = [];
  for (const s of [...sessions].reverse()) {
    const label = dayLabel(new Date(s.updatedAt), now);
    const last = days.at(-1);
    if (last?.label === label) last.sessions.push(s);
    else days.push({ label, sessions: [s] });
  }
  return days;
}
