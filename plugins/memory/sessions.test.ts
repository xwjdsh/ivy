import { expect, test } from "bun:test";
import type { ConversationHistory, PastMessage } from "@ivy/plugin-api";
import { searchSessions } from "./sessions.ts";

/** Sessions given newest first, each as [date, [role, text]...]. */
function history(
  sessions: Record<string, [string, Array<[PastMessage["role"], string]>]>,
): ConversationHistory {
  return {
    sessions: () =>
      Object.entries(sessions).map(([id, [date]]) => ({ id, updatedAt: `${date}T12:00:00.000Z` })),
    messages: (id) =>
      (sessions[id]?.[1] ?? []).map(([role, text]) => ({
        role,
        text,
        ts: `${sessions[id]?.[0]}T12:00:00.000Z`,
      })),
  };
}

const h = history({
  now: ["2026-10-18", [["user", "what was that ffmpeg command?"]]],
  video: [
    "2026-10-15",
    [
      ["user", "shrink this video under 10MB"],
      ["assistant", "Use ffmpeg -i in.mp4 -vcodec libx264 -crf 28 out.mp4"],
      ["user", "thanks"],
      ["user", "and ffmpeg to cut the first 10 seconds?"],
      ["assistant", "ffmpeg -ss 0 -t 10 -i in.mp4 out.mp4"],
    ],
  ],
  deploy: [
    "2026-09-01",
    [
      ["user", "部署方案定了吗"],
      ["assistant", "定了：用 Fly.io，不用 Kubernetes"],
    ],
  ],
});

test("groups hits by session, with neighbors, skipping the current session", () => {
  const out = searchSessions(h, { query: "ffmpeg" }, "now");
  expect(out).toStartWith("1 past session matched:");
  expect(out).toContain("## 2026-10-15 (session video)");
  expect(out).toContain("Ivy: ffmpeg -ss 0 -t 10 -i in.mp4 out.mp4");
  expect(out).toContain("User: thanks"); // the message before a hit, for context
  expect(out).not.toContain("what was that ffmpeg command"); // the current session
});

test("Chinese matches by bigram; since narrows by date", () => {
  expect(searchSessions(h, { query: "部署方案" }, "now")).toContain("用 Fly.io");
  expect(searchSessions(h, { query: "部署方案", since: "2026-10-01" }, "now")).toBe(
    "No past conversation matches.",
  );
});

test("long messages are cut around the match", () => {
  const long = history({
    a: [
      "2026-10-01",
      [["assistant", `${"x ".repeat(400)}the magic word is rosebud ${"y ".repeat(400)}`]],
    ],
  });
  const out = searchSessions(long, { query: "rosebud" }) as string;
  expect(out).toContain("rosebud");
  expect(out).toContain("…");
  expect(out.length).toBeLessThan(500);
});

test("dates are the user's local ones, for `since` and in headers", () => {
  // Pinned to a timezone east of UTC, so the test tells local from UTC dates wherever it
  // runs (a UTC machine, like CI, would see no difference).
  const tz = process.env.TZ;
  process.env.TZ = "Asia/Tokyo";
  try {
    const ts = "2026-10-19T16:00:00.000Z"; // 01:00 on the 20th in Tokyo, still the 19th in UTC
    const early: ConversationHistory = {
      sessions: () => [{ id: "early", updatedAt: ts }],
      messages: () => [{ role: "user", text: "the ffmpeg flags again", ts }],
    };
    const out = searchSessions(early, { query: "ffmpeg", since: "2026-10-20" });
    expect(out).toContain("## 2026-10-20 (session early)");
  } finally {
    process.env.TZ = tz;
  }
});

test("a reply written after outside content taints the session that finds it", () => {
  const ts = "2026-10-15T12:00:00.000Z";
  const searched: ConversationHistory = {
    sessions: () => [{ id: "web", updatedAt: ts }],
    messages: () => [
      { role: "user", text: "what did the review say about the finale?", ts },
      { role: "assistant", text: "It says the finale airs on Friday", ts, outside: true },
    ],
  };
  expect(searchSessions(searched, { query: "finale" })).toMatchObject({ outside: true });
  expect(typeof searchSessions(h, { query: "ffmpeg" }, "now")).toBe("string");
});
