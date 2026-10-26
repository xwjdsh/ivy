// What each turn recalls without the model having to think of it (DESIGN.md §8.1): what the
// user just wrote, scored against the archive and past conversations, the few best hits
// going into the turn's context. The hot files are in the prompt already, so they aren't
// searched. Nothing unasked may taint a turn: a reply that followed outside content and an
// entry saved from it (`ext`) are left out. No model call: one keyword ranking.

import {
  type ConversationHistory,
  localDate,
  type PastMessage,
  recallFrom,
  type Searchable,
  terms,
} from "@ivy/plugin-api";
import type { Line } from "./format.ts";
import { excerpt } from "./sessions.ts";

const CAPS = { kept: 3, said: 2 };

/** Each past message as ranked, made once: the ranking keeps its terms while it lives. */
const searchable = new WeakMap<PastMessage, Searchable>();
function asSearchable(m: PastMessage): Searchable {
  let entry = searchable.get(m);
  if (!entry) {
    entry = { text: m.text, tags: [], date: localDate(new Date(m.ts)) };
    searchable.set(m, entry);
  }
  return entry;
}

export interface RecallInput {
  query: string;
  archive: Line[];
  history: ConversationHistory;
  /** The conversation going on: in context already. */
  sessionId: string;
  /** What this conversation was already given, by id: not given again. */
  given: Set<string>;
}

/** The turn's recall, framed for the model, or none. */
export function recall(input: RecallInput, maxChars: number): string | null {
  type Item = {
    id: string;
    kind: keyof typeof CAPS;
    entry: Searchable & { topic?: string };
    who?: string;
  };
  const items: Item[] = [];
  for (const { raw, entry } of input.archive) {
    if (entry && !entry.ext) items.push({ id: `archive:${raw}`, kind: "kept", entry });
  }
  for (const { id: session } of input.history.sessions()) {
    if (session === input.sessionId) continue;
    input.history.messages(session).forEach((m, i) => {
      if (m.outside) return;
      const who = m.role === "user" ? "the user" : "you";
      items.push({ id: `${session}:${i}`, kind: "said", entry: asSearchable(m), who });
    });
  }
  const words = terms(input.query);
  return recallFrom(items, input.query, {
    from: "from memory and past conversations",
    show: (item) =>
      item.kind === "kept"
        ? {
            meta: `(kept in archive/${item.entry.topic ?? "general"}, ${item.entry.date ?? "undated"})`,
            text: item.entry.text,
          }
        : {
            meta: `(${item.who}, ${item.entry.date})`,
            text: excerpt(item.entry.text.replace(/\s+/g, " "), words),
          },
    caps: CAPS,
    given: input.given,
    maxChars,
  });
}
