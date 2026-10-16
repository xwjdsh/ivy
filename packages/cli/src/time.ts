const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Short, human-friendly age of a timestamp, e.g. "5 min ago", "yesterday 21:03". */
export function relativeTime(iso: string, now = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const diff = now.getTime() - then.getTime();
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (then.getTime() >= startOfToday) return `today ${hhmm(then)}`;
  if (then.getTime() >= startOfToday - DAY) return `yesterday ${hhmm(then)}`;
  if (diff < 7 * DAY) return `${Math.ceil((startOfToday - then.getTime()) / DAY)} days ago`;
  return `${then.getFullYear()}-${pad(then.getMonth() + 1)}-${pad(then.getDate())}`;
}
