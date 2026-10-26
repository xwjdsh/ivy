import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IvyPlugin, ToolResult } from "@ivy/plugin-api";
import { createMemoryPlugin } from "./index.ts";

let dir: string;
let plugin: IvyPlugin;
const log = { debug() {}, info() {}, warn() {}, error() {} };

async function start() {
  plugin = createMemoryPlugin();
  await plugin.setup?.({
    config: plugin.configSchema?.parse({}),
    dataDir: dir,
    soulFile: "",
    log,
    history: { sessions: () => [], messages: () => [], points: () => undefined },
    helper: { complete: async () => "" },
    writer: { complete: async () => "" },
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ivy-topics-"));
  await start();
});

const call = async (name: string, input: object): Promise<ToolResult> => {
  const tool = plugin.tools?.find((t) => t.name === name);
  if (!tool) throw new Error(name);
  return tool.run(input as never, {
    signal: new AbortController().signal,
    log,
    sessionId: "s",
    turn: 1,
    tainted: false,
  });
};
const text = (r: ToolResult) => (typeof r === "string" ? r : r.content);
const topic = (name: string) => join(dir, "archive", `${name}.md`);

test("a topic is started by archiving into it with when it matters, and goes with its last entry", async () => {
  await call("save", { file: "memory", content: "Sister Lin works at Sony" });
  const missing = await call("move", { match: "Sony", to: "archive", topic: "family" });
  expect(text(missing)).toContain('There is no topic "family"');
  const moved = await call("move", {
    match: "Sony",
    to: "archive",
    topic: "family",
    about: "parents, sister Lin, visits home",
    title: "Family · 家人",
  });
  expect(text(moved)).toContain("Moved from MEMORY.md to archive/family");
  expect(readFileSync(topic("family"), "utf8")).toMatch(
    /^# Family · 家人\nWhen it matters: parents, sister Lin, visits home\n\n- \[fact [\d-]+\] Sister Lin works at Sony\n$/,
  );
  // Read whole, and listed for the model with its count.
  expect(text(await call("read_topic", { topic: "family" }))).toContain("Sister Lin works at Sony");
  const prompt = (await plugin.sessionPrompt?.({ id: "s2" })) ?? "";
  expect(prompt).toContain("- family (1): parents, sister Lin, visits home");
  // To another topic, and the emptied one is gone.
  await call("move", { match: "Sony", to: "archive", topic: "general" });
  expect(existsSync(topic("family"))).toBe(false);
  expect(readFileSync(topic("general"), "utf8")).toContain("Sister Lin works at Sony");
});

test("a hot entry keeps its topic, and goes to it once done", async () => {
  await call("move", {
    match: "x",
    to: "archive",
    topic: "health",
    about: "doctors, teeth",
  }).catch(() => undefined); // no entry yet: nothing made
  await call("save", { file: "memory", content: "Old filling", topic: "general" });
  await call("move", {
    match: "Old filling",
    to: "archive",
    topic: "health",
    about: "doctors, teeth",
  });
  const saved = text(
    await call("save", { file: "memory", content: "Dentist", due: "2999-01-01", topic: "health" }),
  );
  expect(saved).toContain("topic:health] Dentist");
  expect(text(await call("save", { file: "memory", content: "x", topic: "nope" }))).toContain(
    'There is no topic "nope"',
  );
  await call("update", { match: "Dentist", done: true });
  const health = readFileSync(topic("health"), "utf8");
  expect(health).toMatch(/- \[todo [\d-]+ due:2999-01-01 done:[\d-]+\] Dentist\n/); // no topic: on disk
});

test("names are short English, topics are capped", async () => {
  await call("save", { file: "memory", content: "A thing" });
  const bad = await call("move", { match: "A thing", to: "archive", topic: "家人", about: "x" });
  expect(text(bad)).toContain("lowercase English letters");
  for (let i = 0; i < 19; i++) {
    await call("save", { file: "memory", content: `Thing number ${i} here` });
    await call("move", { match: `number ${i} `, to: "archive", topic: `t${i}`, about: "x" });
  }
  const full = await call("move", { match: "A thing", to: "archive", topic: "t99", about: "x" });
  expect(text(full)).toContain("20 topics already");
});

test("an entry saved from outside content taints the turn that finds it", async () => {
  await call("save", { file: "memory", content: "Phobos landing in 2027" });
  await call("move", { match: "Phobos", to: "archive" });
  const file = readFileSync(topic("general"), "utf8").replace("] Phobos", " ext] Phobos");
  writeFileSync(topic("general"), file);
  const found = await call("search", { query: "Phobos" });
  expect(typeof found === "object" && found.outside).toBe(true);
  const read = await call("read_topic", { topic: "general" });
  expect(typeof read === "object" && read.outside).toBe(true);
});

test("an entry naming a topic that is gone goes to general, making no topic", async () => {
  await call("save", { file: "memory", content: "Checkup notes" });
  await call("move", { match: "Checkup", to: "archive", topic: "health", about: "doctors" });
  await call("save", {
    file: "memory",
    content: "In hospital",
    ends: "2000-01-02",
    topic: "health",
  });
  await call("move", { match: "Checkup", to: "archive", topic: "general" }); // health empties
  expect(existsSync(topic("health"))).toBe(false);
  await plugin.sessionPrompt?.({ id: "s3" }); // tidying archives the ended entry
  expect(existsSync(topic("health"))).toBe(false);
  expect(readFileSync(topic("general"), "utf8")).toMatch(/until:2000-01-02\] In hospital\n/);
});

test("a line the user wrote in a topic's file stays there", async () => {
  await call("save", { file: "memory", content: "Ken lives in Osaka" });
  await call("move", { match: "Ken", to: "archive", topic: "friend-ken", about: "Ken" });
  writeFileSync(topic("friend-ken"), `${readFileSync(topic("friend-ken"), "utf8")}my own note\n`);
  await call("save", { file: "memory", content: "Ken likes ramen" });
  await call("move", { match: "ramen", to: "archive", topic: "friend-ken" });
  const ken = readFileSync(topic("friend-ken"), "utf8");
  expect(ken).toContain("my own note");
  expect(ken).toContain("Ken likes ramen");
  expect(readFileSync(topic("general"), "utf8")).not.toContain("my own note");
});

test("a topic too long to read whole drops its oldest", async () => {
  await call("save", { file: "memory", content: "Seed entry" });
  await call("move", { match: "Seed", to: "archive", topic: "work", about: "work" });
  const long = Array.from(
    { length: 400 },
    (_, i) => `- [fact 2026-01-01] Work note ${i} ${"x".repeat(80)}`,
  ).join("\n");
  writeFileSync(topic("work"), `# work\nWhen it matters: work\n\n${long}\n`);
  const read = text(await call("read_topic", { topic: "work" }));
  expect(read).toContain("older entries not shown");
  expect(read).toContain("Work note 399");
  expect(read).not.toContain("Work note 0 ");
});

test("general keeps its own title whatever its file's first line says", async () => {
  dir = mkdtempSync(join(tmpdir(), "ivy-topics-"));
  const general = topic("general");
  await start();
  mkdirSync(join(dir, "archive")); // as a file renamed by hand from before topics
  writeFileSync(general, "# Archive\n\n- [fact 2026-01-05] Lived in Tokyo\n");
  const prompt = (await plugin.sessionPrompt?.({ id: "s4" })) ?? "";
  expect(prompt).toContain("- general (1): anything that fits no other topic");
  await call("save", { file: "memory", content: "Old car" });
  await call("move", { match: "Old car", to: "archive" });
  expect(readFileSync(general, "utf8")).toStartWith("# General\nWhen it matters:");
});
