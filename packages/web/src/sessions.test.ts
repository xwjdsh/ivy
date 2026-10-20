import { expect, test } from "bun:test";
import type { SessionSummary } from "@ivy/protocol";
import { byDay, dayLabel, isRecent, timeLabel } from "./sessions.ts";

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

test("past sessions read oldest first, under their day", () => {
  const days = byDay(
    [
      at("a", new Date(2026, 9, 20, 9)),
      at("b", new Date(2026, 9, 20, 0, 5)),
      at("c", new Date(2026, 9, 19, 23)),
      at("d", new Date(2026, 9, 12)),
    ],
    now,
  );
  expect(days.map((d) => [d.label, d.sessions.map((s) => s.id)])).toEqual([
    ["Oct 12", ["d"]],
    ["Yesterday", ["c"]],
    ["Today", ["b", "a"]],
  ]);
});

test("a conversation from the last few hours is carried on", () => {
  const ms = now.getTime();
  expect(isRecent(at("a", new Date(2026, 9, 20, 12)), ms)).toBe(true);
  expect(isRecent(at("b", new Date(2026, 9, 20, 8)), ms)).toBe(false);
});
