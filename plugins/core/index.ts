import { type ConversationHistory, definePlugin, defineTool, localDate } from "@ivy/plugin-api";
import { z } from "zod";
import { continuity } from "./continuity.ts";
import {
  addTo,
  daysBetween,
  inTimezone,
  localTimezone,
  nowLine,
  parseDate,
  UNITS,
  weekdayOf,
} from "./dates.ts";

/**
 * "Don't keep that", said after: what the user said from a message on is taken back
 * (DESIGN.md §11, M3). The kernel marks the part, so key points, notes, recall and search
 * never read it, and each plugin undoes what its tools wrote there.
 */
const takeBack = defineTool({
  name: "take_back",
  description:
    "When the user asks you not to keep something they said in this conversation (\"刚才那个别记了\", \"forget I said that\"): take back what was said from that message on. `from` is a piece of the user's message where it starts, word for word. What was saved from it is removed and anything changed is listed, and that part is left out of everything read later (key points, notes, recall, search). It stays in this conversation's context until the conversation ends: say it won't be kept, not that it's forgotten now.",
  input: z.object({
    from: z.string().describe("A piece of the user's message where the part starts, word for word"),
  }),
  summary: (i) => `take back from "${i.from}"`,
  risk: "write",
  own: "records",
  defaultAllow: true,
  takesBack: true,
  // A page read this turn mustn't be able to make her erase what the user had her keep.
  askFirst: (_, { tainted }) => (tainted ? "this turn read outside content" : undefined),
  async run({ from }, ctx) {
    if (!ctx.takeBack) return { content: "Taking back isn't available here.", isError: true };
    const r = await ctx.takeBack(from);
    if ("candidates" in r) {
      return {
        content: `That doesn't match exactly one of the user's messages here. Their messages:\n${r.candidates.map((c) => `- ${c}`).join("\n")}\nCall again with a piece of the right one, or ask which they mean.`,
        isError: true,
      };
    }
    return [
      "Taken back: from that message on, nothing is read later (key points, notes, recall, search).",
      ...r.undone,
      "Notes and reviews already written (the reflection plugin's days/ and weeks/) and what the day's pass already kept in the archive aren't changed: if they hold it, the user can edit or delete them there.",
    ].join("\n");
  },
});

const dateCalc = defineTool({
  name: "date_calc",
  description: [
    "Exact date arithmetic. Simple steps from today's date in the context (tomorrow, next Wednesday) need no tool; use this for anything harder, where mental date math goes wrong: the weekday of another date, day counts across months or years, adding months, timezone conversion.",
    'op "weekday": the weekday of `date`.',
    'op "diff": calendar days from `date` to `to` (negative if `to` is earlier).',
    'op "add": `date` plus `amount` `unit` (negative to subtract); months clamp to month end.',
    'op "convert": the instant `date` shown in `timezone` (IANA name, e.g. Europe/Paris).',
    "Dates are YYYY-MM-DD (local) or ISO date-times; `date` defaults to now.",
  ].join(" "),
  input: z.object({
    op: z.enum(["weekday", "diff", "add", "convert"]),
    date: z.string().optional().describe("YYYY-MM-DD or ISO date-time; default: now"),
    to: z.string().optional().describe('For "diff": the other date'),
    amount: z.number().int().optional().describe('For "add": how many units, may be negative'),
    unit: z.enum(UNITS).optional().describe('For "add"'),
    timezone: z.string().optional().describe('For "convert": target IANA timezone'),
  }),
  summary({ op, date, to, amount, unit, timezone }) {
    const from = date ?? "now";
    switch (op) {
      case "weekday":
        return `weekday of ${from}`;
      case "diff":
        return `days from ${from} to ${to ?? "?"}`;
      case "add":
        return `${from} ${(amount ?? 0) < 0 ? "-" : "+"} ${Math.abs(amount ?? 0)} ${unit ?? ""}`.trim();
      case "convert":
        return `${from} in ${timezone ?? "?"}`;
    }
  },
  risk: "read",
  own: "records",
  run({ op, date, to, amount, unit, timezone }) {
    const start = date ? parseDate(date) : new Date();
    const day = (d: Date) => `${localDate(d)} (${weekdayOf(d)})`;
    switch (op) {
      case "weekday":
        return day(start);
      case "diff": {
        if (!to) throw new Error('"diff" needs `to`');
        const end = parseDate(to);
        const days = daysBetween(start, end);
        const weeks = Math.trunc(days / 7);
        const rest = days % 7;
        const breakdown = Math.abs(days) >= 7 ? ` = ${weeks} weeks ${rest} days` : "";
        return `${days} days from ${day(start)} to ${day(end)}${breakdown}`;
      }
      case "add": {
        if (amount === undefined || !unit) throw new Error('"add" needs `amount` and `unit`');
        const result = addTo(start, amount, unit);
        const withTime = unit === "hours" || unit === "minutes";
        return withTime ? inTimezone(result, localTimezone()) : day(result);
      }
      case "convert":
        if (!timezone) throw new Error('"convert" needs `timezone`');
        return `${inTimezone(start, localTimezone())} = ${inTimezone(start, timezone)}`;
    }
  },
});

export function createCorePlugin() {
  let history: ConversationHistory | undefined;
  return definePlugin({
    id: "core",
    version: "0.3.0",
    description:
      "The time in every turn's context, how long since the user last wrote, and where the last conversation was left; a date arithmetic tool.",
    tools: [dateCalc, takeBack],
    setup(ctx) {
      history = ctx.history;
    },
    contextFor: ({ sessionId, now }) => {
      const since = history && continuity(history, sessionId, now);
      return since ? `${nowLine(now)}\n${since}` : nowLine(now);
    },
  });
}

export default createCorePlugin();
