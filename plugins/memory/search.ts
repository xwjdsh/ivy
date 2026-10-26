// Near-duplicate checks for memory entries, over the same terms as search (plugin-api).

import { terms } from "@ivy/plugin-api";

const NUMBER = /\d+(?:[-./:]\d+)*/g;

type Similarity = { kind: "duplicate" | "similar" | "different"; overlap: number };

const DUPLICATE_AT = 0.9;
const SIMILAR_AT = 0.5;

/**
 * Compare a new text with an existing line. Overlap is the Jaccard index of their terms.
 * Nearly equal texts are duplicates unless the difference is something that matters: a
 * number or date, or a rare word (one no other line of the file uses, like a name or a
 * version). Those are at most "similar": "passport expires 2026-12" vs "… 2027-12".
 * `others` are the terms of the rest of the file, to tell rare words from common ones.
 */
export function compare(text: string, existing: string, others: Set<string>[]): Similarity {
  const a = new Set(terms(text));
  const b = new Set(terms(existing));
  const shared = [...a].filter((t) => b.has(t)).length;
  const overlap = a.size + b.size === 0 ? 1 : shared / (a.size + b.size - shared);
  if (overlap >= DUPLICATE_AT && !vetoed(text, existing, a, b, others)) {
    return { kind: "duplicate", overlap };
  }
  return { kind: overlap >= SIMILAR_AT ? "similar" : "different", overlap };
}

function vetoed(
  text: string,
  existing: string,
  a: Set<string>,
  b: Set<string>,
  others: Set<string>[],
): boolean {
  const numbers = (s: string) => [...(s.match(NUMBER) ?? [])].sort().join(" ");
  if (numbers(text) !== numbers(existing)) return true;
  const differing = [...a].filter((t) => !b.has(t)).concat([...b].filter((t) => !a.has(t)));
  return differing.some((t) => !others.some((o) => o.has(t)));
}
