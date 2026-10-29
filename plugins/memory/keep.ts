// The day's memory pass (docs/design/companion.md#memory-that-serves-the-conversation): after each
// day there was talk, the writer reads what was said and names what the user said that should have
// been kept and wasn't; code keeps each in the archive, never a hot file, if nothing like it is in
// any file. It reads the day as the jobs do, without replies from outside content, so what it keeps
// is untainted. What it kept is listed for /memory.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationHistory, WriterModel } from "@ivy/plugin-api";
import { daysEnded, dayTranscript, type JobRun, type Logger } from "@ivy/plugin-api";
import type { MemoryFiles } from "./files.ts";
import KEEP from "./keep.md" with { type: "text" };
import { type Context, type Files, keep } from "./store.ts";

/** The writer's answer for a day with nothing to keep. */
const NOTHING = "NOTHING";
/** Days of kept lines /memory lists. */
const SHOWN_DAYS = 7;

export interface KeepDeps {
  files: MemoryFiles;
  history: ConversationHistory;
  writer: WriterModel;
  log: Logger;
  context(files: Files): Context;
}

/** Run the pass over every day that ended since the last run. */
export async function keepDays(deps: KeepDeps, { now, since, signal }: JobRun): Promise<void> {
  for (const date of daysEnded(since, now)) {
    const talk = dayTranscript(deps.history, date);
    if (!talk) continue;
    const answer = await deps.writer.complete({
      system: KEEP.trim().replaceAll("{{date}}", date),
      prompt: talk,
      signal,
    });
    const kept: string[] = [];
    for (const item of parse(answer)) {
      const { line } = await deps.files.change((files): { line?: string; files?: Files } => {
        try {
          const out = keep(deps.context(files), { ...item, date });
          return out ?? {};
        } catch (err) {
          // One the safety scan or a date check refused: the rest are still kept.
          deps.log.warn("not kept from the day's pass", { date, err: String(err) });
          return {};
        }
      });
      if (line) {
        kept.push(line);
        deps.log.info("kept from the day's talk", { date, line });
      }
    }
    if (kept.length) record(deps.files.dir, date, kept);
  }
}

type Item = {
  content: string;
  type?: "fact" | "note";
  tags?: string[];
  since?: string;
  ends?: string;
  topic?: string;
};

/** The writer's lines: one JSON object each; anything else is skipped. */
export function parse(answer: string): Item[] {
  if (answer.trim() === NOTHING) return [];
  return answer.split("\n").flatMap((line) => {
    try {
      const o = JSON.parse(line.trim()) as Record<string, unknown>;
      if (typeof o.content !== "string" || !o.content.trim()) return [];
      const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
      return [
        {
          content: o.content,
          ...(o.type === "note" && { type: "note" as const }),
          ...(str(o.tags) && { tags: (o.tags as string).split(",").map((t) => t.trim()) }),
          ...(str(o.since) && { since: str(o.since) }),
          ...(str(o.ends) && { ends: str(o.ends) }),
          ...(str(o.topic) && { topic: str(o.topic) }),
        },
      ];
    } catch {
      return [];
    }
  });
}

const recordFile = (dir: string) => join(dir, "kept.json");

/** What the pass kept, by day, for /memory: the last week's. */
export function keptLately(dir: string): Array<{ date: string; lines: string[] }> {
  try {
    const file = recordFile(dir);
    if (!existsSync(file)) return [];
    const all: unknown = JSON.parse(readFileSync(file, "utf8"));
    // A file edited by hand or damaged lists what is sound in it, rather than failing /memory.
    const sound = (d: unknown): d is { date: string; lines: string[] } =>
      typeof (d as { date?: unknown })?.date === "string" &&
      Array.isArray((d as { lines?: unknown }).lines) &&
      (d as { lines: unknown[] }).lines.every((l) => typeof l === "string");
    return Array.isArray(all) ? all.filter(sound).slice(-SHOWN_DAYS) : [];
  } catch {
    return [];
  }
}

function record(dir: string, date: string, lines: string[]): void {
  const days = keptLately(dir).filter((d) => d.date !== date);
  // Whole or not at all: a crash mid-write would otherwise leave half a file.
  const file = recordFile(dir);
  writeFileSync(`${file}.tmp`, `${JSON.stringify([...days, { date, lines }], null, 1)}\n`);
  renameSync(`${file}.tmp`, file);
}
