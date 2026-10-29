// Finding what was said (⌘K in the window): messages, the user's and Ivy's, holding every word
// of a query as typed, newest first, each with a little of what is around the match. Read
// through the history plugins read, so one off the record or a part taken back is never found.

import type { ConversationHistory } from "@ivy/plugin-api";
import type { MessageHit } from "@ivy/protocol";

/** At most this many: more words narrow them. */
const MAX_HITS = 30;
/** Characters kept on each side of the match. */
const AROUND = 40;

export function findMessages(history: ConversationHistory, query: string): MessageHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const first = words[0];
  if (!first) return [];
  const hits: MessageHit[] = [];
  for (const { id } of history.sessions()) {
    const nth = { user: 0, assistant: 0 };
    for (const m of history.messages(id)) {
      const lower = m.text.toLowerCase();
      if (!words.every((w) => lower.includes(w))) continue;
      const at = lower.indexOf(first);
      hits.push({
        sessionId: id,
        ts: m.ts,
        role: m.role,
        nth: nth[m.role]++,
        text: around(m.text, at, at + first.length),
      });
    }
  }
  return hits.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, MAX_HITS);
}

/** The text from a little before `from` to a little after `to`, on one line. */
function around(text: string, from: number, to: number): string {
  const start = Math.max(0, from - AROUND);
  const end = Math.min(text.length, to + AROUND);
  const cut = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${cut}${end < text.length ? "…" : ""}`;
}
