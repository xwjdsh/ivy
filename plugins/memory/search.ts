// Keyword search and near-duplicate checks for memory entries. No index and no
// embeddings: a linear scan is fine for one person's memory.
//
// Text becomes terms: Latin words (lowercased) and overlapping CJK bigrams, so Chinese
// and Japanese match without a segmenter. A switch between scripts is always a boundary,
// so "修改youer服务端" contains the word "youer".

import type { Entry } from "./format.ts";

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
// A CJK run, or a run of other letters and digits; never both, so scripts always split.
const RUN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}])+/gu;
const NUMBER = /\d+(?:[-./:]\d+)*/g;

/** Terms of a text: words and CJK bigrams (a lone CJK character is its own term). */
export function terms(text: string): string[] {
  const out: string[] = [];
  for (const run of text.toLowerCase().match(RUN) ?? []) {
    if (!CJK.test(run)) {
      out.push(run);
      continue;
    }
    const chars = [...run];
    if (chars.length === 1) out.push(run);
    for (let i = 0; i + 1 < chars.length; i++) out.push(`${chars[i]}${chars[i + 1]}`);
  }
  return out;
}

export interface Searchable {
  entry: Entry;
}

export interface Hit<T> {
  item: T;
  score: number;
}

const K1 = 1.2;
const B = 0.75;
const TAG_WEIGHT = 2;
const PREFIX_WEIGHT = 0.5;
const MIN_PREFIX = 3;

/**
 * Rank items by BM25 over their text and tags (tags count double). Any matching term
 * counts, so a reworded query still finds something. A query word also matches longer
 * words it starts ("dent" → "dentist") at half weight, and a single CJK character matches
 * any text containing it. Ties go to the entry with the later date, then the later line.
 */
export function search<T extends Searchable>(items: T[], query: string, limit = 10): Hit<T>[] {
  const queryTerms = [...new Set(terms(query))];
  if (queryTerms.length === 0) return [];
  const docs = items.map((item) => docTerms(item.entry));
  const avgLength = docs.reduce((n, d) => n + d.length, 0) / Math.max(1, docs.length) || 1;

  // Term weights per document, computed once; document frequency follows from them.
  const tfs = queryTerms.map((q) => docs.map((d) => matchWeight(q, d.counts)));
  const idfs = tfs.map((tf) => {
    const df = tf.filter((w) => w > 0).length;
    return Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
  });
  const scores = docs.map((doc, i) => {
    let score = 0;
    tfs.forEach((perDoc, q) => {
      const tf = perDoc[i] ?? 0;
      if (tf === 0) return;
      const norm = tf + K1 * (1 - B + (B * doc.length) / avgLength);
      score += (idfs[q] ?? 0) * ((tf * (K1 + 1)) / norm);
    });
    return score;
  });

  return items
    .map((item, i) => ({ item, score: scores[i] ?? 0, i }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || newer(a.item.entry, b.item.entry) || b.i - a.i)
    .slice(0, limit)
    .map(({ item, score }) => ({ item, score }));
}

/** Positive when b is dated later than a. */
function newer(a: Entry, b: Entry): number {
  return (b.date ?? "").localeCompare(a.date ?? "");
}

function docTerms(entry: Entry): { counts: Map<string, number>; length: number } {
  const counts = new Map<string, number>();
  const add = (t: string, w: number) => counts.set(t, (counts.get(t) ?? 0) + w);
  const text = terms(entry.text);
  for (const t of text) add(t, 1);
  const tags = entry.tags.flatMap(terms);
  for (const t of tags) add(t, TAG_WEIGHT);
  return { counts, length: text.length + tags.length * TAG_WEIGHT };
}

/** How strongly a query term occurs in a document's term counts. */
function matchWeight(q: string, counts: Map<string, number>): number {
  const exact = counts.get(q) ?? 0;
  if (exact > 0) return exact;
  let partial = 0;
  const single = CJK.test(q) && [...q].length === 1;
  for (const [t, n] of counts) {
    if (single ? t.includes(q) : !CJK.test(q) && q.length >= MIN_PREFIX && t.startsWith(q)) {
      partial += n * (single ? 1 : PREFIX_WEIGHT);
    }
  }
  return partial;
}

export type Similarity =
  | { kind: "duplicate"; overlap: number }
  | { kind: "similar"; overlap: number }
  | { kind: "different"; overlap: number };

export const DUPLICATE_AT = 0.9;
export const SIMILAR_AT = 0.5;

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
