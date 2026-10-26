import { expect, test } from "bun:test";

process.env.TZ = "America/New_York"; // days of 25 and 23 hours

const { daysEnded } = await import("@ivy/plugin-api");
const { weeksEnded } = await import("./index.ts");

test("a day of 25 or 23 hours is still one day, ended at 04:00", () => {
  // Clocks went back on 1 November 2026, forward on 8 March 2026.
  expect(daysEnded(new Date("2026-10-31T05:00"), new Date("2026-11-02T04:30"))).toEqual([
    "2026-10-31",
    "2026-11-01",
  ]);
  expect(daysEnded(new Date("2026-03-07T05:00"), new Date("2026-03-09T04:30"))).toEqual([
    "2026-03-07",
    "2026-03-08",
  ]);
  expect(weeksEnded(new Date("2026-11-01T12:00"), new Date("2026-11-02T04:30"))).toEqual([
    {
      name: "2026-W44",
      days: [
        "2026-10-26",
        "2026-10-27",
        "2026-10-28",
        "2026-10-29",
        "2026-10-30",
        "2026-10-31",
        "2026-11-01",
      ],
    },
  ]);
});
