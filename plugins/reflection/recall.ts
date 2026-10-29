// What each turn recalls from the daily notes (docs/design/memory.md#per-turn-context): what the
// user just wrote, scored against what the notes say the user said and what was seen to recur, a
// sentence at a time. Never what Ivy sensed: an impression is hers, not the user's truth, and would
// go to the model with every request it matched. No model call: one keyword ranking.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { recallFrom } from "@ivy/plugin-api";

/** The parts of a note that may be recalled, by their headings (day.md asks for them so). */
const KEPT = new Set(["said", "seen"]);

/** Sentences of the notes' Said and Seen parts, with the note's date. */
export function noteSentences(daysDir: string): Array<{ date: string; text: string }> {
  if (!existsSync(daysDir)) return [];
  return readdirSync(daysDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .flatMap((f) => {
      const date = f.slice(0, 10);
      let part = "";
      return readFileSync(join(daysDir, f), "utf8")
        .split("\n")
        .flatMap((line) => {
          const heading = /^##\s+(.+?)\s*$/.exec(line);
          if (heading) {
            part = (heading[1] ?? "").toLowerCase();
            return [];
          }
          if (!KEPT.has(part)) return [];
          return line
            .split(/(?<=[。！？!?])|(?<=\.)\s+/)
            .map((s) => s.replace(/^[-*]\s*/, "").trim())
            .filter(Boolean)
            .map((text) => ({ date, text }));
        });
    });
}

/** The turn's recall from the notes, or none. */
export function recallNotes(
  daysDir: string,
  query: string,
  given: Set<string>,
  maxChars: number,
): string | null {
  const items = noteSentences(daysDir).map((s) => ({
    id: `${s.date}:${s.text}`,
    kind: "note",
    entry: { text: s.text, tags: [], date: s.date },
  }));
  return recallFrom(items, query, {
    from: "from your notes of the user's days",
    show: (item) => ({ meta: `(${item.entry.date})`, text: item.entry.text }),
    caps: { note: 2 },
    given,
    maxChars,
  });
}
