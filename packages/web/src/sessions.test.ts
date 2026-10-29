import { expect, test } from "bun:test";
import type { SessionSummary } from "@ivy/protocol";
import { carriesOn, dayLabel, timeLabel, when } from "./sessions.ts";

const at = (id: string, updated: Date): SessionSummary => ({
  id,
  createdAt: updated.toISOString(),
  updatedAt: updated.toISOString(),
  turns: 1,
  preview: id,
  busy: false,
});

const now = new Date(2026, 9, 20, 15); // a Tuesday

test("days read the way people say them", () => {
  expect(dayLabel(new Date(2026, 9, 20, 0, 5), now)).toBe("Today");
  expect(dayLabel(new Date(2026, 9, 19, 23), now)).toBe("Yesterday");
  expect(dayLabel(new Date(2026, 9, 15), now)).toBe("Thursday");
  expect(dayLabel(new Date(2026, 9, 12), now)).toBe("Oct 12");
  expect(dayLabel(new Date(2025, 9, 12), now)).toBe("Oct 12, 2025");
  expect(timeLabel(new Date(2026, 9, 20, 9, 5))).toBe("9:05");
});

test("a stretch is marked by its time, and its day where the day changed", () => {
  const iso = (d: Date) => d.toISOString();
  const today = iso(new Date(2026, 9, 20, 9));
  expect(when(today, iso(new Date(2026, 9, 20, 5)), now)).toBe("9:00");
  expect(when(today, iso(new Date(2026, 9, 19, 23)), now)).toBe("Today 9:00");
  expect(when(today, undefined, now)).toBe("Today 9:00");
  // Past midnight is still the night before's, until 04:00.
  const late = iso(new Date(2026, 9, 20, 0, 5));
  expect(when(late, iso(new Date(2026, 9, 19, 23)), now)).toBe("0:05");
  expect(when(late, undefined, now)).toBe("Yesterday 0:05");
  expect(when(iso(new Date(2026, 9, 12, 12)), undefined, now)).toBe("Oct 12 12:00");
});

test("the talk carries on until a pause, a new day, or too large a prompt", () => {
  const ms = now.getTime();
  expect(carriesOn(at("a", new Date(2026, 9, 20, 13)), 0, ms)).toBe(true);
  expect(carriesOn(at("b", new Date(2026, 9, 20, 11)), 0, ms)).toBe(false);
  expect(carriesOn(at("c", new Date(2026, 9, 20, 13)), 79_999, ms)).toBe(true);
  expect(carriesOn(at("c", new Date(2026, 9, 20, 13)), 80_000, ms)).toBe(false);
  // Past midnight is the same day until 04:00; then a new one starts.
  const at330 = new Date(2026, 9, 21, 3, 30).getTime();
  expect(carriesOn(at("d", new Date(2026, 9, 21, 1)), 0, at330)).toBe(true);
  expect(carriesOn(at("e", new Date(2026, 9, 21, 3)), 0, at330 + 3600_000)).toBe(false);
  // Her message, unanswered, is answered where she wrote it, while she waits for it.
  const hers = (d: Date) => ({ ...at("f", d), turns: 0, fromIvy: true as const });
  expect(carriesOn(hers(new Date(2026, 9, 19, 9)), 0, ms)).toBe(true);
  expect(carriesOn(hers(new Date(2026, 9, 16, 9)), 0, ms)).toBe(false);
});
