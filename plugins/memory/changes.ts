// What changed in an always-loaded file since the session prompt was built: by Ivy in this
// session, by hand, or by another session. The prompt keeps its snapshot (the cache holds);
// the turn's context carries the difference, so the model never works from a stale file.

import type { Line } from "./format.ts";

/** At most this many changed lines per file and turn; beyond that the model is pointed elsewhere. */
export const MAX_CHANGES = 20;

/** A file's lines, to compare later: entries and hand-written lines, not blanks. */
export function lineSet(lines: Line[]): Set<string> {
  return new Set(lines.map((l) => l.raw.trimEnd()).filter((l) => l.trim() !== ""));
}

/**
 * Lines added (`+`) and removed (`-`) since `before`, under a heading naming the file, or
 * null when nothing changed. Past MAX_CHANGES, `more` says where to look for the rest.
 */
export function changeNotice(
  name: string,
  before: Set<string>,
  now: Set<string>,
  more: string,
): string | null {
  const changes = [
    ...[...now].filter((l) => !before.has(l)).map((l) => `+ ${l}`),
    ...[...before].filter((l) => !now.has(l)).map((l) => `- ${l}`),
  ];
  if (changes.length === 0) return null;
  const shown = changes.slice(0, MAX_CHANGES);
  const rest =
    changes.length > shown.length
      ? `\n(${changes.length - shown.length} more changes; ${more})`
      : "";
  return `${name} changed since this session started:\n${shown.join("\n")}${rest}`;
}
