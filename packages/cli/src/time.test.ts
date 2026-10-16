import { expect, test } from "bun:test";
import { relativeTime } from "./time.ts";

test("relative time buckets", () => {
  const now = new Date(2026, 9, 16, 12, 0); // local time, Fri 16 Oct 2026 12:00
  const at = (y: number, mo: number, d: number, h: number, mi: number, s = 0) =>
    new Date(y, mo, d, h, mi, s).toISOString();
  expect(relativeTime(at(2026, 9, 16, 11, 59, 30), now)).toBe("just now");
  expect(relativeTime(at(2026, 9, 16, 11, 50), now)).toBe("10 min ago");
  expect(relativeTime(at(2026, 9, 16, 8, 5), now)).toBe("today 08:05");
  expect(relativeTime(at(2026, 9, 15, 21, 3), now)).toBe("yesterday 21:03");
  expect(relativeTime(at(2026, 9, 13, 9, 0), now)).toBe("3 days ago");
  expect(relativeTime(at(2026, 8, 1, 9, 0), now)).toBe("2026-09-01");
  expect(relativeTime("not a date", now)).toBe("");
});
