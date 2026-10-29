// The talk as one thread: conversations are the stretches of it, split by the daemon where it
// paused (thread.ts there), read back whole, oldest first, the way a long conversation with
// someone reads when you scroll back.

/** A new day starts at this hour, as the thread's and her notes' days do (plugin-api's). */
const ROLLOVER_HOUR = 4;

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
