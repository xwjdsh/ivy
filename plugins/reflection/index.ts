// The user's days and weeks, in Ivy's words (DESIGN.md §11, M3): a note for each day there
// was talk, and a look back at each week built from those notes, written by one job each
// morning and kept as files under the plugin's data. How they will be used is open; for now
// they are files the user can read, edit or delete.

import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type ConversationHistory,
  definePlugin,
  localDate,
  localTime,
  type WriterModel,
} from "@ivy/plugin-api";
import DAY from "./day.md" with { type: "text" };
import WEEK from "./week.md" with { type: "text" };

/** A day ends at this hour, so a talk past midnight belongs to the day it began in. */
const ROLLOVER_HOUR = 4;
/** What the writer is given of a long day: its end, where it was left. */
const MAX_DAY_CHARS = 60_000;
/** The writer's answer for a day with nothing of the user's in it. */
const NOTHING = "NOTHING";
/** As points.ts marks them (DESIGN.md §8.1). */
const LEFT_OUT = "[a reply from what a web page or search said, left out]";

const DAY_MS = 24 * 60 * 60 * 1000;

export function createReflectionPlugin() {
  let state: { dir: string; history: ConversationHistory; writer: WriterModel } | undefined;
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
    jobs: [
      {
        name: "reflect",
        at: () => `${String(ROLLOVER_HOUR).padStart(2, "0")}:00`,
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

/** When a local date's day starts: its rollover hour. */
function dayStart(date: string): Date {
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  return new Date(y, m - 1, d, ROLLOVER_HOUR);
}

/** The local date a moment's day began on (before the rollover hour, the date before). */
function dayOf(at: Date): string {
  return localDate(
    new Date(at.getFullYear(), at.getMonth(), at.getDate(), at.getHours() - ROLLOVER_HOUR),
  );
}

/** The days that ended after `since`, up to `now`, oldest first. */
export function daysEnded(since: Date, now: Date): string[] {
  const out: string[] = [];
  // From the day `since` falls in; one is ended once the next one has started.
  for (let date = dayOf(since); ; date = nextDate(date)) {
    const end = dayStart(nextDate(date));
    if (end > now) break;
    if (end > since) out.push(date);
  }
  return out;
}

function nextDate(date: string): string {
  const start = dayStart(date);
  // Noon, so a 23- or 25-hour day doesn't land on the wrong date.
  return localDate(new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1, 12));
}

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
 * A day's conversations as the writer reads them: what was said in it, in the order said,
 * conversation by conversation; Ivy's replies in turns that read outside content left out
 * (§8.1). Empty when the user said nothing that day.
 */
export function dayTranscript(history: ConversationHistory, date: string): string {
  const start = dayStart(date);
  const end = dayStart(nextDate(date));
  const parts: Array<{ from: Date; text: string }> = [];
  let said = false;
  // Any session active since the day began may hold some of it.
  for (const { id, updatedAt } of history.sessions()) {
    if (new Date(updatedAt) < start) continue;
    let from: Date | undefined;
    const lines = history.messages(id).flatMap((m) => {
      const at = new Date(m.ts);
      if (at < start || at >= end) return [];
      if (m.role === "user") said = true;
      from ??= at;
      const text = m.outside ? LEFT_OUT : m.text;
      return [`${m.role === "user" ? "User" : "Ivy"} (${localTime(at)}): ${text}`];
    });
    if (from) parts.push({ from, text: `--- a conversation ---\n${lines.join("\n\n")}` });
  }
  // In the order the conversations began, so the day reads as it went.
  parts.sort((a, b) => a.from.getTime() - b.from.getTime());
  return said
    ? parts
        .map((p) => p.text)
        .join("\n\n")
        .slice(-MAX_DAY_CHARS)
    : "";
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
