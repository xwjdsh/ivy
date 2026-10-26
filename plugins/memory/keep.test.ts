import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TZ = "Asia/Tokyo"; // local days and the 04:00 rollover, wherever the tests run

const { createMemoryPlugin } = await import("./index.ts");
type History = import("@ivy/plugin-api").ConversationHistory;

const at = (s: string) => new Date(s);
const day = (texts: Array<[string, string, string, boolean?]>): History => ({
  sessions: () => [{ id: "s1", updatedAt: at("2026-10-23T22:00").toISOString() }],
  messages: () =>
    texts.map(([role, ts, text, outside]) => ({
      role: role as "user" | "assistant",
      text,
      ts: at(ts).toISOString(),
      ...(outside && { outside }),
    })),
  points: () => undefined,
});

async function run(h: History, answer: string, memory = "") {
  const dir = mkdtempSync(join(tmpdir(), "ivy-keep-"));
  if (memory) writeFileSync(join(dir, "MEMORY.md"), `# Memory\n\n${memory}\n`);
  const asked: Array<{ system: string; prompt: string }> = [];
  const p = createMemoryPlugin();
  await p.setup?.({
    config: p.configSchema?.parse({}),
    dataDir: dir,
    soulFile: "",
    log: { debug() {}, info() {}, warn() {}, error() {} },
    history: h,
    helper: { complete: async () => "" },
    writer: {
      async complete(call) {
        asked.push(call);
        return answer;
      },
    },
  });
  await p.jobs?.[0]?.run({
    since: at("2026-10-23T05:00"),
    now: at("2026-10-24T04:30"),
    signal: new AbortController().signal,
  });
  const overview =
    (await p.commands?.find((c) => c.name === "/memory")?.run("", { log: console })) ?? "";
  const file = join(dir, "archive", "general.md");
  const archive = existsSync(file) ? readFileSync(file, "utf8") : ""; // none written: none kept
  return { dir, asked, archive, overview };
}

const TALK = day([
  ["user", "2026-10-23T20:00", "妹妹 Lin 下周一开始去 Sony 上班了"],
  ["assistant", "2026-10-23T20:01", "Lin 要去 Sony 了！"],
  ["assistant", "2026-10-23T20:02", "The news says Sony is hiring", true],
]);

test("keeps in the archive what was said and not saved, dated the day it was said", async () => {
  const { asked, archive, overview } = await run(
    TALK,
    [
      '{"content": "妹妹 Lin 2026-10-26 开始在 Sony 上班", "tags": "sister, Sony", "since": "2026-10-26"}',
      "not json",
      '{"content": "The user\'s API key is sk-test-abcdefghijklmnopqrstuvwx"}',
    ].join("\n"),
  );
  expect(archive).toContain(
    "- [fact 2026-10-23 since:2026-10-26] 妹妹 Lin 2026-10-26 开始在 Sony 上班 #sister #Sony",
  );
  expect(archive).not.toContain("sk-test"); // the scan refuses a secret; the rest are kept
  expect(overview).toContain("Kept in the archive from the last days' talk");
  expect(overview).toContain("妹妹 Lin 2026-10-26 开始在 Sony 上班");
  // The day as the jobs read it: the reply from outside content left out.
  expect(asked[0]?.prompt).toContain("妹妹 Lin 下周一开始去 Sony 上班了");
  expect(asked[0]?.prompt).not.toContain("Sony is hiring");
  expect(asked[0]?.system).toContain("2026-10-23");
});

test("nothing kept that a file already has, nor for NOTHING", async () => {
  const known = "- [fact 2026-10-20] 妹妹 Lin 2026-10-26 开始在 Sony 上班";
  const again = await run(TALK, '{"content": "妹妹 Lin 2026-10-26 开始在 Sony 上班"}', known);
  expect(again.archive).not.toContain("Lin");
  expect(again.overview).not.toContain("Kept in the archive");
  const none = await run(TALK, "NOTHING");
  expect(none.archive).not.toContain("Lin");
});

test("a re-run over the same day keeps nothing twice; a failed writer records nothing", async () => {
  const answer = '{"content": "妹妹 Lin 2026-10-26 开始在 Sony 上班"}';
  const first = await run(TALK, answer);
  const line = first.archive.split("\n").find((l) => l.includes("Lin")) ?? "";
  const again = await run(TALK, answer, line);
  expect(again.archive).not.toContain("Lin");
  const dir = mkdtempSync(join(tmpdir(), "ivy-keep-"));
  const p = createMemoryPlugin();
  await p.setup?.({
    config: p.configSchema?.parse({}),
    dataDir: dir,
    soulFile: "",
    log: { debug() {}, info() {}, warn() {}, error() {} },
    history: TALK,
    helper: { complete: async () => "" },
    writer: { complete: async () => Promise.reject(new Error("down")) },
  });
  const job = p.jobs?.[0]?.run({
    since: at("2026-10-23T05:00"),
    now: at("2026-10-24T04:30"),
    signal: new AbortController().signal,
  });
  await expect(job).rejects.toThrow("down");
  expect(existsSync(join(dir, "kept.json"))).toBe(false);
});
