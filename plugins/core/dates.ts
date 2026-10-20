// Date helpers for the core plugin. Calendar dates are local (the machine's timezone)
// unless a timezone is given; "2026-10-21" means that day locally, not UTC midnight.

import { localDate } from "@ivy/plugin-api";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_MS = 24 * 60 * 60 * 1000;

const pad = (n: number) => String(n).padStart(2, "0");

export function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** "+09:00" for a Date in the machine's timezone. */
function utcOffset(d: Date): string {
  const minutes = -d.getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function weekdayOf(d: Date): string {
  return WEEKDAYS[d.getDay()] ?? "";
}

/** The per-turn context line, minute precision: "Now: 2026-10-16 Friday 18:27 (Asia/Tokyo, UTC+09:00)". */
export function nowLine(now: Date): string {
  return `Now: ${localDate(now)} ${weekdayOf(now)} ${pad(now.getHours())}:${pad(now.getMinutes())} (${localTimezone()}, UTC${utcOffset(now)})`;
}

/** Parse "YYYY-MM-DD" as a local calendar date; anything else as an ISO date-time. */
export function parseDate(text: string): Date {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  const d = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(text);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Can't read "${text}" as a date; use YYYY-MM-DD or an ISO date-time`);
  }
  return d;
}

/** Whole calendar days from a to b (local dates; DST-safe). */
export function daysBetween(a: Date, b: Date): number {
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((ub - ua) / DAY_MS);
}

export const UNITS = ["days", "weeks", "months", "years", "hours", "minutes"] as const;
export type Unit = (typeof UNITS)[number];

/** Add an amount; months/years clamp to the last day of the month (Jan 31 + 1 month = Feb 28/29). */
export function addTo(d: Date, amount: number, unit: Unit): Date {
  const out = new Date(d);
  switch (unit) {
    case "minutes":
      return new Date(d.getTime() + amount * 60_000);
    case "hours":
      return new Date(d.getTime() + amount * 3_600_000);
    case "days":
      out.setDate(out.getDate() + amount);
      return out;
    case "weeks":
      out.setDate(out.getDate() + amount * 7);
      return out;
    case "months":
    case "years": {
      const months = unit === "years" ? amount * 12 : amount;
      const target = new Date(
        d.getFullYear(),
        d.getMonth() + months,
        1,
        d.getHours(),
        d.getMinutes(),
      );
      const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
      target.setDate(Math.min(d.getDate(), lastDay));
      return target;
    }
  }
}

/** "2026-10-16 Friday 18:27 (Asia/Tokyo)" for an instant in any IANA timezone. */
export function inTimezone(d: Date, timezone: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "long",
      hourCycle: "h23",
    }).formatToParts(d);
  } catch {
    throw new Error(`Unknown timezone "${timezone}"; use an IANA name like Europe/Paris`);
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("weekday")} ${get("hour")}:${get("minute")} (${timezone})`;
}
