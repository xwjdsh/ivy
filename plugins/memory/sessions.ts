// Search over past conversations: what the user and Ivy said, read through the kernel's
// read-only history. Same scorer as memory search. Hits are grouped by session, so one
// long conversation can't crowd out the others, and each hit comes with a neighboring
// message for context. All sessions are searched; an index can come when it gets slow.

import type { ConversationHistory, PastMessage } from "@ivy/plugin-api";
import { localDate } from "./format.ts";
import { search, terms } from "./search.ts";

export interface SessionSearchInput {
  query: string;
  /** YYYY-MM-DD, local: only sessions active since then. */
  since?: string;
  /** How many sessions to show. */
  limit?: number;
}

/** Hits looked at before grouping; enough for every shown session to have its best ones. */
const MAX_HITS = 300;
/** Characters of a message shown around the match. */
const EXCERPT = 300;
/** Hits shown per session (each with one message before and after). */
const HITS_PER_SESSION = 2;

export function searchSessions(
  history: ConversationHistory,
  input: SessionSearchInput,
  currentSession?: string,
): string {
  const limit = input.limit ?? 3;
  const sessions = history
    .sessions()
    // The current conversation is in context already, and its last message is the question.
    .filter(
      (s) =>
        s.id !== currentSession &&
        (!input.since || localDate(new Date(s.updatedAt)) >= input.since),
    );
  const items = sessions.flatMap((s) => {
    const messages = history.messages(s.id);
    return messages.map((m, index) => ({
      session: s.id,
      messages,
      index,
      entry: { text: m.text, tags: [], date: localDate(new Date(m.ts)) },
    }));
  });

  // Group hits by session, in the order of each session's best hit.
  const groups = new Map<string, typeof items>();
  for (const hit of search(items, input.query, MAX_HITS)) {
    const group = groups.get(hit.session) ?? [];
    if (group.length < HITS_PER_SESSION) group.push(hit);
    groups.set(hit.session, group);
  }
  const shown = [...groups.values()].slice(0, limit);
  if (shown.length === 0) return "No past conversation matches.";

  const words = terms(input.query);
  const blocks = shown.map((hits) => {
    const first = hits[0] as (typeof items)[number];
    const indexes = new Set<number>();
    for (const h of hits) for (const i of [h.index - 1, h.index, h.index + 1]) indexes.add(i);
    const lines = [...indexes]
      .filter((i) => i >= 0 && i < first.messages.length)
      .sort((a, b) => a - b)
      .map((i) => line(first.messages[i] as PastMessage, words));
    return `## ${first.entry.date} (session ${first.session})\n${lines.join("\n")}`;
  });
  return [
    `${shown.length} past ${shown.length === 1 ? "session" : "sessions"} matched:`,
    ...blocks,
  ].join("\n\n");
}

function line(m: PastMessage, words: string[]): string {
  return `${m.role === "user" ? "User" : "Ivy"}: ${excerpt(m.text.replace(/\s+/g, " "), words)}`;
}

/** The part of a long message around the first matching word. */
function excerpt(text: string, words: string[]): string {
  if (text.length <= EXCERPT) return text;
  const lower = text.toLowerCase();
  const found = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0);
  const at = found.length ? Math.min(...found) : 0;
  const start = Math.max(0, Math.min(at - EXCERPT / 3, text.length - EXCERPT));
  const end = start + EXCERPT;
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}
