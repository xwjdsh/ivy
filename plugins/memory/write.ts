// Writing entry lines, for any file in the memory line format: memory's three files and
// the journal's IVY.md. What the model must fix comes back as a MemoryError whose message
// says how; files are written whole and one change at a time.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Line, normalizeTags, splitTags } from "./format.ts";
import { scan } from "./safety.ts";

/** Thrown for anything the model should fix and retry; the message says how. */
export class MemoryError extends Error {}

/** The entry text and its tags: those passed in plus any `#tags` typed at the end of the text. */
export function contentAndTags(content: string, tags: string[]): { text: string; tags: string[] } {
  const split = splitTags(cleanText(content));
  return { text: cleanText(split.text), tags: normalizeTags([...tags, ...split.tags]) };
}

function cleanText(content: string): string {
  const text = content.trim();
  if (!text) throw new MemoryError("The entry is empty.");
  if (/[\r\n]/.test(text)) throw new MemoryError("One entry per line: no line breaks.");
  return text;
}

/**
 * Every line Ivy writes is scanned first (safety.ts); a rejected one is never written.
 * `about` says what the file holds, so the model knows why and what to do instead.
 */
export function checkSafe(line: Line, about: string): Line {
  const finding = scan(line.raw);
  if (finding) throw new MemoryError(`Not saved: ${finding.reason}. ${about}`);
  return line;
}

/**
 * The one item whose entry line contains `match`. None or several is an error the model
 * can act on: `notFound` says where to look, `label` shows each candidate.
 */
export function findOne<T extends { line: Line }>(
  items: T[],
  match: string,
  how: { notFound: string; label(item: T): string },
): T {
  const needle = match.trim();
  if (!needle) throw new MemoryError("`match` is empty: give a piece of the line to change.");
  const hits = items.filter((item) => item.line.entry && item.line.raw.includes(needle));
  if (hits.length === 1) return hits[0] as T;
  if (hits.length === 0) throw new MemoryError(`No entry contains "${needle}". ${how.notFound}`);
  const shown = hits
    .slice(0, 5)
    .map((h) => `  ${how.label(h)}`)
    .join("\n");
  throw new MemoryError(
    `"${needle}" matches ${hits.length} entries; use a longer piece of the one you mean:\n${shown}`,
  );
}

/** Write a file whole: a temp file, then a rename, so a crash never leaves half of it. */
export function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}

/** Runs changes one at a time: a model may call several write tools in one step, in parallel. */
export class Serial {
  private queue: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => T): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }
}
