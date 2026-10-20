import { definePlugin, defineTool, localDate } from "@ivy/plugin-api";
import { z } from "zod";
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

export default definePlugin({
  id: "core",
  version: "0.2.0",
  description: "Current time in every turn's context; a date arithmetic tool.",
  tools: [dateCalc],
  contextFor: ({ now }) => nowLine(now),
});
