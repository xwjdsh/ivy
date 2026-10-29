// The talk as one thread: conversations are the stretches of it, split where it paused (a few
// hours apart, a new day, or grown too large for the model), read back whole, oldest first, the
// way a long conversation with someone reads when you scroll back.

import type { SessionSummary } from "@ivy/protocol";

/** A pause this long ends a stretch of the talk: what is written after it starts the next. */
export const PAUSE_MS = 3 * 60 * 60 * 1000;
/** A new day starts at this hour, as her notes' days do (plugin-api's ROLLOVER_HOUR). */
const ROLLOVER_HOUR = 4;
/** A stretch whose prompt has grown this large ends: each turn sends all of it again. */
export const MAX_CONTEXT = 80_000;
/** A message of Ivy's unanswered this long is let go, as the daemon lets it go (writes-first). */
const HERS_MS = 3 * 24 * 60 * 60 * 1000;

/** The day a time belongs to, a new one starting at 04:00: past midnight is still the night. */
const talkDay = (d: Date) =>
  new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    d.getHours() - ROLLOVER_HOUR,
    d.getMinutes(),
  );
const dayOf = (t: number) => talkDay(new Date(t)).toDateString();

/** A message of Ivy's, written first and not answered yet. */
export const isHers = (s: SessionSummary) => s.fromIvy === true && s.turns === 0;

/**
 * Whether what is written now carries on this conversation rather than starting the next
 * stretch: it was active within a pause, on the same day, and hasn't grown too large. A message
 * of Ivy's, unanswered, is answered where she wrote it, for as long as she waits for it.
 */
export function carriesOn(s: SessionSummary, context = 0, now = Date.now()): boolean {
  const at = Date.parse(s.updatedAt);
  if (isHers(s)) return now - at < HERS_MS;
  return now - at < PAUSE_MS && dayOf(at) === dayOf(now) && context < MAX_CONTEXT;
}

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

/**
 * Where a stretch began, set apart from the one before it: the time alone on the same day, else
 * the day too ("Yesterday 22:10"), a day starting at 04:00 as the talk's does. Without a time,
 * now.
 */
export function when(at: string | undefined, before?: string, now = new Date()): string {
  const date = at ? new Date(at) : now;
  if (before && dayOf(Date.parse(before)) === dayOf(date.getTime())) return timeLabel(date);
  return `${dayLabel(talkDay(date), talkDay(now))} ${timeLabel(date)}`;
}
