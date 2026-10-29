// A sense of time and of going on (docs/design/companion.md#a-sense-of-time-and-of-going-on): how
// long since the user last wrote, and, as a conversation starts, where the last one was left.

import { type ConversationHistory, localDate, localTime } from "@ivy/plugin-api";
import { weekdayOf } from "./dates.ts";

/** Less than this since the user last wrote is one stretch of talk: nothing to say. */
const GAP_MS = 60 * 60 * 1000;
/** A last conversation older than this isn't picked up from. */
const PICK_UP_MS = 30 * 24 * 60 * 60 * 1000;
/** Conversations looked at for the user's last message, as one starts, newest first. */
const RECENT = 5;

/** When the user last wrote, and in which conversation. */
function lastWritten(history: ConversationHistory): { sessionId: string; at: Date } | undefined {
  let last: { sessionId: string; at: Date } | undefined;
  for (const { id } of history.sessions().slice(0, RECENT)) {
    const said = history.messages(id).findLast((m) => m.role === "user");
    const at = said && new Date(said.ts);
    if (at && (!last || at > last.at)) last = { sessionId: id, at };
  }
  return last;
}

/** "3 hours ago", "2 days ago" */
function ago(from: Date, now: Date): string {
  const hours = Math.floor((now.getTime() - from.getTime()) / (60 * 60 * 1000));
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

const when = (d: Date) => `${localDate(d)} ${weekdayOf(d)} ${localTime(d)}`;

/**
 * Lines for a turn's context: the time since the user last wrote, after a while apart; and
 * at a conversation's start, what the last one was about and left open, as the helper
 * summed it up. Null when there is nothing to say.
 */
export function continuity(
  history: ConversationHistory,
  sessionId: string,
  now: Date,
): string | null {
  // Going on: the user's last message is this conversation's. Starting: whichever was last.
  const said = history.messages(sessionId).findLast((m) => m.role === "user");
  const starting = said === undefined;
  const last = starting ? lastWritten(history) : { sessionId, at: new Date(said.ts) };
  if (!last) return null;
  const lines: string[] = [];
  if (now.getTime() - last.at.getTime() >= GAP_MS) {
    const where = last.sessionId === sessionId ? "" : ", in another conversation";
    lines.push(`The user last wrote ${ago(last.at, now)} (${when(last.at)})${where}.`);
  }
  const points = starting && last.sessionId !== sessionId && history.points(last.sessionId);
  if (points && now.getTime() - last.at.getTime() < PICK_UP_MS) {
    lines.push(
      `The last conversation, as summed up after it (not the user's words): "${points.title}". ${points.points.join(" ")}`,
    );
    if (points.open.length) lines.push(`Left open there: ${points.open.join("; ")}`);
  }
  return lines.length ? lines.join("\n") : null;
}
