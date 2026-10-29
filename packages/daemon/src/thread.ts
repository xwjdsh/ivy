// One thread (docs/design/interfaces.md#the-chat-window): what the user writes goes on in the
// conversation going on, or starts the next one where the talk paused (a few hours apart, a new
// day, or grown too large for the model). The daemon decides, so every client keeps the same
// thread.

import { ROLLOVER_HOUR } from "@ivy/plugin-api";
import type { SessionSummary } from "@ivy/protocol";

/** A pause this long ends a stretch of the talk: what is written after it starts the next. */
export const PAUSE_MS = 3 * 60 * 60 * 1000;
/** A stretch whose prompt has grown this large ends: each turn sends all of it again. */
export const MAX_CONTEXT = 80_000;
/**
 * A message of Ivy's unanswered is waited on this long: answered where she wrote it until
 * then, and holding back her next one (writes-first.ts); after, it is let go.
 */
export const WAITS_MS = 3 * 24 * 60 * 60 * 1000;

/** The day a time belongs to, a new one starting at 04:00: past midnight is still the night. */
const dayOf = (t: number) => {
  const d = new Date(t);
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    d.getHours() - ROLLOVER_HOUR,
    d.getMinutes(),
  ).toDateString();
};

/** A message of Ivy's, written first and not answered yet. */
export const isHers = (s: SessionSummary) => s.fromIvy === true && s.turns === 0;

/**
 * Whether what is written now carries on this conversation rather than starting the next
 * stretch: it was active within a pause, on the same day, and hasn't grown too large. A message
 * of Ivy's, unanswered, is answered where she wrote it, for as long as she waits for it.
 */
export function carriesOn(s: SessionSummary, context = 0, now = Date.now()): boolean {
  const at = Date.parse(s.updatedAt);
  if (isHers(s)) return now - at < WAITS_MS;
  return now - at < PAUSE_MS && dayOf(at) === dayOf(now) && context < MAX_CONTEXT;
}
