import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TZ = "Asia/Tokyo"; // local days and the 04:00 rollover, wherever the tests run

const { createReflectionPlugin, dayTranscript, daysEnded, isoWeek, weeksEnded } = await import(
  "./index.ts"
);
type History = import("@ivy/plugin-api").ConversationHistory;

const at = (s: string) => new Date(s); // local, as TZ says

/** Sessions, each its messages as [role, local time, text, outside?]. */
function history(sessions: Record<string, Array<[string, string, string, boolean?]>>): History {
  return {
    sessions: () =>
      Object.entries(sessions)
        .map(([id, ms]) => ({ id, updatedAt: at(ms.at(-1)?.[1] ?? "").toISOString() }))
        .reverse(),
    messages: (id) =>
      (sessions[id] ?? []).map(([role, ts, text, outside]) => ({
        role: role as "user" | "assistant",
        text,
        ts: at(ts).toISOString(),
        ...(outside && { outside }),
      })),
    points: () => undefined,
  };
}

async function plugin(h: History, answers: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "ivy-reflect-"));
  const asked: Array<{ system: string; prompt: string }> = [];
  const p = createReflectionPlugin();
  await p.setup?.({
    config: {},
    dataDir: dir,
    soulFile: "",
    log: { debug() {}, info() {}, warn() {}, error() {} },
    history: h,
    helper: { complete: async () => "" },
    writer: {
      async complete(call) {
        asked.push(call);
        return answers.shift() ?? "";
      },
    },
  });
  const job = p.jobs?.[0];
  if (!job) throw new Error("no job");
  const run = (since: string, now: string) =>
    job.run({ since: at(since), now: at(now), signal: new AbortController().signal });
  return { dir, asked, run, job };
}

test("a day ends at 04:00; days and weeks are done once they have ended", () => {
  expect(daysEnded(at("2026-10-22T05:00"), at("2026-10-24T04:30"))).toEqual([
    "2026-10-22",
    "2026-10-23",
  ]);
  expect(daysEnded(at("2026-10-23T05:00"), at("2026-10-24T03:59"))).toEqual([]);
  expect(isoWeek("2026-10-25")).toBe("2026-W43");
  expect(isoWeek("2027-01-01")).toBe("2026-W53");
  expect(weeksEnded(at("2026-10-25T12:00"), at("2026-10-26T04:01"))).toEqual([
    {
      name: "2026-W43",
      days: [
        "2026-10-19",
        "2026-10-20",
        "2026-10-21",
        "2026-10-22",
        "2026-10-23",
        "2026-10-24",
        "2026-10-25",
      ],
    },
  ]);
});

test("a day's talk, past midnight included, without Ivy's replies after outside content", () => {
  const h = history({
    a: [
      ["user", "2026-10-22T21:00", "拔牙有点怕"],
      ["assistant", "2026-10-22T21:01", "怕很正常"],
      ["user", "2026-10-23T01:30", "睡不着"],
      ["assistant", "2026-10-23T01:31", "页面说……", true],
    ],
    b: [["user", "2026-10-23T09:00", "next day"]],
  });
  const talk = dayTranscript(h, "2026-10-22");
  expect(talk).toContain("User (21:00): 拔牙有点怕");
  expect(talk).toContain("User (01:30): 睡不着");
  expect(talk).toContain("[a reply from what a web page or search said, left out]");
  expect(talk).not.toContain("页面说");
  expect(talk).not.toContain("next day");
  expect(
    dayTranscript(history({ c: [["assistant", "2026-10-22T10:00", "hi"]] }), "2026-10-22"),
  ).toBe("");
});

test("each morning: the days since, once each; nothing worth a note writes nothing; a deleted note stays deleted", async () => {
  const h = history({
    a: [["user", "2026-10-21T20:00", "面试过了"]],
    b: [["user", "2026-10-22T20:00", "hi"]],
  });
  const { dir, asked, run } = await plugin(h, ["## Said\n面试过了。", "NOTHING"]);
  await run("2026-10-21T04:30", "2026-10-23T04:05");
  expect(asked[0]?.system).toContain("2026-10-21");
  expect(readFileSync(join(dir, "days", "2026-10-21.md"), "utf8")).toBe(
    "# 2026-10-21\n\n## Said\n面试过了。\n",
  );
  expect(existsSync(join(dir, "days", "2026-10-22.md"))).toBe(false);
  // The next morning: only the day since. The user deleted the 21st's: not written again.
  rmSync(join(dir, "days", "2026-10-21.md"));
  await run("2026-10-23T04:05", "2026-10-24T04:05");
  expect(asked).toHaveLength(2);
  expect(existsSync(join(dir, "days", "2026-10-21.md"))).toBe(false);
});

test("a week's look back is built from its days' notes as they are on disk, never over an existing one", async () => {
  const { dir, asked, run } = await plugin(history({}), ["## Said\n这周不错。", "again"]);
  mkdirSync(join(dir, "days"), { recursive: true });
  writeFileSync(
    join(dir, "days", "2026-10-21.md"),
    "# 2026-10-21\n\n## Said\n面试过了。（我改的）\n",
  );
  await run("2026-10-25T05:00", "2026-10-26T04:05");
  expect(asked[0]?.system).toContain("2026-W43 (2026-10-19 to 2026-10-25)");
  expect(asked[0]?.prompt).toContain("（我改的）");
  expect(readFileSync(join(dir, "weeks", "2026-W43.md"), "utf8")).toContain("这周不错。");
  writeFileSync(join(dir, "weeks", "2026-W43.md"), "mine");
  await run("2026-10-25T05:00", "2026-10-26T04:05");
  expect(readFileSync(join(dir, "weeks", "2026-W43.md"), "utf8")).toBe("mine");
});
