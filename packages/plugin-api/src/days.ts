// A user's day, as the jobs that look back on it read it
// (docs/design/companion.md#notes-and-reviews): it ends at the rollover hour, so a talk past
// midnight belongs to the day it began in, and what was said in it is the user's words and Ivy's
// replies, but not those that came from outside content.

import { localDate, localTime } from "./dates.ts";
import type { ConversationHistory } from "./index.ts";

/** A day ends at this hour, so a talk past midnight belongs to the day it began in. */
export const ROLLOVER_HOUR = 4;
/** The rollover as a job's time: when the day just ended is there to look back on. */
export const ROLLOVER_TIME = `${String(ROLLOVER_HOUR).padStart(2, "0")}:00`;
/** A reply that came from outside content, as what reads past conversations unasked shows it. */
export const LEFT_OUT = "[a reply from what a web page or search said, left out]";
/** What a job is given of a long day: its end, where it was left. */
const MAX_DAY_CHARS = 60_000;

/** When a local date's day starts: its rollover hour. */
export function dayStart(date: string): Date {
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  return new Date(y, m - 1, d, ROLLOVER_HOUR);
}

/** The local date a moment's day began on (before the rollover hour, the date before). */
function dayOf(at: Date): string {
  return localDate(
    new Date(at.getFullYear(), at.getMonth(), at.getDate(), at.getHours() - ROLLOVER_HOUR),
  );
}

/** The days that ended after `since`, up to `now`, oldest first. */
export function daysEnded(since: Date, now: Date): string[] {
  const out: string[] = [];
  // From the day `since` falls in; one is ended once the next one has started.
  for (let date = dayOf(since); ; date = nextDate(date)) {
    const end = dayStart(nextDate(date));
    if (end > now) break;
    if (end > since) out.push(date);
  }
  return out;
}

export function nextDate(date: string): string {
  const start = dayStart(date);
  // Noon, so a 23- or 25-hour day doesn't land on the wrong date.
  return localDate(new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1, 12));
}

/**
 * A day's conversations as the writer reads them: what was said in it, in the order said,
 * conversation by conversation; Ivy's replies in turns that read outside content left out
 * (docs/design/security.md#a-turn-that-read-outside-content). Empty when the user said nothing that
 * day.
 */
export function dayTranscript(history: ConversationHistory, date: string): string {
  const start = dayStart(date);
  const end = dayStart(nextDate(date));
  const parts: Array<{ from: Date; text: string }> = [];
  let said = false;
  // Any session active since the day began may hold some of it.
  for (const { id, updatedAt } of history.sessions()) {
    if (new Date(updatedAt) < start) continue;
    let from: Date | undefined;
    const lines = history.messages(id).flatMap((m) => {
      const at = new Date(m.ts);
      if (at < start || at >= end) return [];
      if (m.role === "user") said = true;
      from ??= at;
      const text = m.outside ? LEFT_OUT : m.text;
      return [`${m.role === "user" ? "User" : "Ivy"} (${localTime(at)}): ${text}`];
    });
    if (from) parts.push({ from, text: `--- a conversation ---\n${lines.join("\n\n")}` });
  }
  // In the order the conversations began, so the day reads as it went.
  parts.sort((a, b) => a.from.getTime() - b.from.getTime());
  return said
    ? parts
        .map((p) => p.text)
        .join("\n\n")
        .slice(-MAX_DAY_CHARS)
    : "";
}
