import { expect, test } from "bun:test";

process.env.TZ = "Asia/Tokyo"; // deterministic local time for these tests

const { addTo, daysBetween, inTimezone, nowLine, parseDate } = await import("./dates.ts");
const core = (await import("./index.ts")).default;

const tool = (name: string) => {
  const t = core.tools?.find((x) => x.name === name);
  if (!t) throw new Error(name);
  return (input: object) => t.run(input as never, {} as never);
};

test("per-turn context: date, weekday, minute and timezone", () => {
  expect(nowLine(new Date(2026, 9, 16, 18, 7, 59))).toBe(
    "Now: 2026-10-16 Friday 18:07 (Asia/Tokyo, UTC+09:00)",
  );
  expect(core.contextFor?.({ sessionId: "s", userText: "", now: new Date(2026, 0, 2, 3, 4) })).toBe(
    "Now: 2026-01-02 Friday 03:04 (Asia/Tokyo, UTC+09:00)",
  );
});

test("YYYY-MM-DD is a local date, not UTC midnight", () => {
  const d = parseDate("2026-10-21");
  expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 9, 21, 0]);
  expect(() => parseDate("next tuesday")).toThrow("Can't read");
});

test("calendar day differences", () => {
  expect(daysBetween(parseDate("2026-10-16"), parseDate("2026-12-25"))).toBe(70);
  expect(daysBetween(parseDate("2026-10-16"), parseDate("2026-10-01"))).toBe(-15);
});

test("adding months clamps to the end of the month", () => {
  const fmt = (d: Date) => d.toLocaleDateString("sv-SE");
  expect(fmt(addTo(parseDate("2026-01-31"), 1, "months"))).toBe("2026-02-28");
  expect(fmt(addTo(parseDate("2028-01-31"), 1, "months"))).toBe("2028-02-29");
  expect(fmt(addTo(parseDate("2026-10-16"), -2, "weeks"))).toBe("2026-10-02");
  expect(fmt(addTo(parseDate("2024-02-29"), 1, "years"))).toBe("2025-02-28");
});

test("timezone conversion", () => {
  expect(inTimezone(new Date("2026-10-16T09:00:00Z"), "Europe/Paris")).toBe(
    "2026-10-16 Friday 11:00 (Europe/Paris)",
  );
  expect(() => inTimezone(new Date(), "Mars/Base")).toThrow("Unknown timezone");
});

test("date_calc tool: weekday, diff, add, convert", () => {
  const calc = tool("date_calc");
  expect(calc({ op: "weekday", date: "2026-10-21" })).toBe("2026-10-21 (Wednesday)");
  expect(calc({ op: "diff", date: "2026-10-16", to: "2026-12-25" })).toBe(
    "70 days from 2026-10-16 (Friday) to 2026-12-25 (Friday) = 10 weeks 0 days",
  );
  expect(calc({ op: "add", date: "2026-10-16", amount: 100, unit: "days" })).toBe(
    "2027-01-24 (Sunday)",
  );
  expect(
    calc({ op: "convert", date: "2026-10-16T18:00:00+09:00", timezone: "America/New_York" }),
  ).toBe("2026-10-16 Friday 18:00 (Asia/Tokyo) = 2026-10-16 Friday 05:00 (America/New_York)");
});

test("date_calc explains missing arguments", () => {
  const calc = tool("date_calc");
  expect(() => calc({ op: "diff", date: "2026-10-16" })).toThrow('"diff" needs `to`');
  expect(() => calc({ op: "add" })).toThrow('"add" needs `amount` and `unit`');
});

const { continuity } = await import("./continuity.ts");
type History = import("@ivy/plugin-api").ConversationHistory;

/** Sessions newest first, each with its messages as [role, local time]. */
function history(
  sessions: Record<string, Array<["user" | "assistant", Date]>>,
  points: Record<string, { title: string; points: string[]; open: string[] }> = {},
): History {
  return {
    sessions: () => Object.keys(sessions).map((id) => ({ id, updatedAt: "" })),
    messages: (id) =>
      (sessions[id] ?? []).map(([role, at]) => ({ role, text: "…", ts: at.toISOString() })),
    points: (id) => (points[id] ? { ...points[id], through: "" } : undefined),
  };
}

test("after a while apart, how long; at a conversation's start, where the last was left", () => {
  const now = new Date(2026, 9, 23, 21, 0);
  const h = history(
    {
      old: [
        ["user", new Date(2026, 9, 20, 22, 15)],
        ["assistant", new Date(2026, 9, 20, 22, 16)],
      ],
    },
    { old: { title: "面试准备", points: ["周四有面试。"], open: ["面试结果"] } },
  );
  expect(continuity(h, "new", now)).toBe(
    [
      "The user last wrote 2 days ago (2026-10-20 Tuesday 22:15), in another conversation.",
      'The last conversation, as summed up after it (not the user\'s words): "面试准备". 周四有面试。',
      "Left open there: 面试结果",
    ].join("\n"),
  );
  // Later in the same conversation, the last one isn't brought up again.
  const going = history({
    now: [["user", new Date(2026, 9, 23, 17, 30)]],
    old: [["user", new Date(2026, 9, 20, 22, 15)]],
  });
  expect(continuity(going, "now", now)).toBe(
    "The user last wrote 3 hours ago (2026-10-23 Friday 17:30).",
  );
  // Talking on: nothing to say.
  expect(
    continuity(history({ now: [["user", new Date(2026, 9, 23, 20, 40)]] }), "now", now),
  ).toBeNull();
});
