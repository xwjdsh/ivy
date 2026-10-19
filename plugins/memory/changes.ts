// What changed in an always-loaded file since the session prompt was built: by Ivy in this
// session, by hand, or by another session. The prompt keeps its snapshot (the cache holds);
// the turn's context carries the difference, so the model never works from a stale file.

import type { Line } from "./format.ts";

/** A file's lines, to compare later: entries and hand-written lines, not blanks. */
export function lineSet(lines: Line[]): Set<string> {
  return new Set(lines.map((l) => l.raw.trimEnd()).filter((l) => l.trim() !== ""));
}

/**
 * Lines added (`+`) and removed (`-`) since `before`, under a heading naming the file, or
 * null when nothing changed. It fits in `maxChars` (the turn's context is cut off past the
 * plugin's share, CONTEXT_MAX_CHARS): whole lines while they fit, then a last line saying
 * how many more there are and `more`, where to find them.
 */
export function changeNotice(
  name: string,
  before: Set<string>,
  now: Set<string>,
  more: string,
  maxChars: number,
): string | null {
  const changes = [
    ...[...now].filter((l) => !before.has(l)).map((l) => `+ ${l}`),
    ...[...before].filter((l) => !now.has(l)).map((l) => `- ${l}`),
  ];
  if (changes.length === 0) return null;
  const rest = (n: number) => `(${n} more changes; ${more})`;
  const out = [`${name} changed since this session started:`];
  let used = out[0]?.length ?? 0;
  for (const [i, change] of changes.entries()) {
    // Room for this line, and for the "more" line if any come after it.
    const after = i + 1 < changes.length ? rest(changes.length - i - 1).length + 1 : 0;
    if (used + 1 + change.length + after > maxChars) {
      out.push(rest(changes.length - i));
      break;
    }
    out.push(change);
    used += 1 + change.length;
  }
  return out.join("\n");
}
