// The user's days and weeks, in Ivy's words (docs/design/companion.md#notes-and-reviews): a note
// for each day there was talk, and a look back at each week built from those notes, written by one
// job each morning and kept as files under the plugin's data. How they will be used is open; for
// now they are files the user can read, edit or delete.

import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CONTEXT_MAX_CHARS,
  type ConversationHistory,
  dayStart,
  daysEnded,
  dayTranscript,
  definePlugin,
  localDate,
  ROLLOVER_TIME,
  type WriterModel,
} from "@ivy/plugin-api";
import DAY from "./day.md" with { type: "text" };
import { recallNotes } from "./recall.ts";
import WEEK from "./week.md" with { type: "text" };

/** The writer's answer for a day with nothing of the user's in it. */
const NOTHING = "NOTHING";
const DAY_MS = 24 * 60 * 60 * 1000;

export function createReflectionPlugin() {
  let state: { dir: string; history: ConversationHistory; writer: WriterModel } | undefined;
  /** What each conversation's recall already gave, so nothing is given twice. */
  const recalled = new Map<string, Set<string>>();
  const ready = () => {
    if (!state) throw new Error("reflection plugin not set up");
    return state;
  };

  return definePlugin({
    id: "reflection",
    version: "0.1.0",
    description:
      "The user's days and weeks in Ivy's words: a note each day, a look back each week.",
    setup(ctx) {
      state = { dir: ctx.dataDir, history: ctx.history, writer: ctx.writer };
    },
    sessionReleased({ id }) {
      recalled.delete(id);
    },
    contextFor({ sessionId, userText }) {
      const given = recalled.get(sessionId) ?? new Set<string>();
      recalled.set(sessionId, given);
      return recallNotes(join(ready().dir, "days"), userText, given, CONTEXT_MAX_CHARS);
    },
    jobs: [
      {
        name: "reflect",
        at: () => ROLLOVER_TIME,
        async run({ now, since, signal }) {
          const { dir, history, writer } = ready();
          // Days first: a week is built from its days' notes.
          for (const date of daysEnded(since, now)) {
            const file = join(dir, "days", `${date}.md`);
            if (existsSync(file)) continue;
            const talk = dayTranscript(history, date);
            if (!talk) continue;
            const note = await writer.complete({
              system: DAY.trim().replace("{{date}}", date),
              prompt: talk,
              signal,
            });
            if (note.trim() === NOTHING || !note.trim()) continue;
            writeOnce(file, `# ${date}\n\n${note.trim()}\n`);
          }
          for (const week of weeksEnded(since, now)) {
            const file = join(dir, "weeks", `${week.name}.md`);
            if (existsSync(file)) continue;
            // As they are on disk: the user's edits are theirs, a deleted day is left out.
            const notes = week.days.flatMap((date) => {
              const day = join(dir, "days", `${date}.md`);
              return existsSync(day) ? [readFileSync(day, "utf8").trim()] : [];
            });
            if (notes.length === 0) continue;
            const review = await writer.complete({
              system: WEEK.trim()
                .replace("{{week}}", week.name)
                .replace("{{from}}", week.days[0] ?? "")
                .replace("{{to}}", week.days[6] ?? ""),
              prompt: notes.join("\n\n"),
              signal,
            });
            if (review.trim()) writeOnce(file, `# ${week.name}\n\n${review.trim()}\n`);
          }
        },
      },
    ],
  });
}

export default createReflectionPlugin();

/**
 * The ISO weeks (Monday to Sunday) that ended after `since`, up to `now`: a week ends when
 * its Sunday's day does, at the rollover hour on Monday.
 */
export function weeksEnded(since: Date, now: Date): Array<{ name: string; days: string[] }> {
  return daysEnded(since, now)
    .filter((date) => dayStart(date).getDay() === 0)
    .map((sunday) => {
      const days = [sunday];
      while (days.length < 7) days.unshift(previousDate(days[0] ?? sunday));
      return { name: isoWeek(sunday), days };
    });
}

function previousDate(date: string): string {
  const start = dayStart(date);
  return localDate(new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1, 12));
}

/** "2026-W43": the ISO year and week of a date (its Thursday decides the year). */
export function isoWeek(date: string): string {
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Write a file that doesn't exist yet, whole or not at all: never over one that does (the
 * user's edits are theirs), and never a half-written one a crash would leave as done.
 */
function writeOnce(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  try {
    linkSync(tmp, file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  } finally {
    rmSync(tmp, { force: true });
  }
}
