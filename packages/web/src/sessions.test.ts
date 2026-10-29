import { expect, test } from "bun:test";
import { dayLabel, timeLabel, when } from "./sessions.ts";

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
