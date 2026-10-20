import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTEXT_MAX_CHARS, type IvyPlugin, type ToolResult } from "@ivy/plugin-api";
import { createMemoryPlugin, localDate, tagList } from "./index.ts";

let dir: string;
let plugin: IvyPlugin;
const today = localDate(new Date());
const log = { debug() {}, info() {}, warn() {}, error() {} };

async function start(settings: Record<string, unknown> = {}) {
  plugin = createMemoryPlugin();
  const config = plugin.configSchema?.parse(settings);
  await plugin.setup?.({
    config,
    dataDir: dir,
    log,
    history: { sessions: () => [], messages: () => [] },
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ivy-mem-"));
  await start();
});

const call = (name: string, input: object): Promise<ToolResult> => {
  const tool = plugin.tools?.find((t) => t.name === name);
  if (!tool) throw new Error(name);
  return Promise.resolve(
    tool.run(input as never, { signal: new AbortController().signal, log, sessionId: "s" }),
  );
};
const text = (r: ToolResult) => (typeof r === "string" ? r : r.content);
const file = (name: string) => readFileSync(join(dir, name), "utf8");

test("save writes MEMORY.md with its header and reports usage", async () => {
  const r = await call("save", {
    file: "memory",
    content: "Dentist at 15:00",
    due: "2026-10-21",
    tags: "牙医",
  });
  expect(text(r)).toMatch(
    /^Saved to MEMORY.md \(\d+ \/ 8,000 chars\):\n- \[todo \d{4}-\d\d-\d\d due:2026-10-21\] Dentist at 15:00 #牙医$/,
  );
  expect(file("MEMORY.md")).toStartWith("# Memory\n");
  expect(file("MEMORY.md")).toContain("Dentist at 15:00 #牙医\n");
  expect(existsSync(join(dir, "ARCHIVE.md"))).toBe(true);
});

test("errors come back to the model, not thrown", async () => {
  const r = await call("update", { match: "nothing like this" });
  expect(r).toEqual({
    content: 'No entry contains "nothing like this". Search memory to find the exact wording.',
    isError: true,
  });
});

test("parallel saves in one step don't overwrite each other", async () => {
  await Promise.all(
    ["Alpha", "Bravo", "Charlie", "Delta"].map((w) =>
      call("save", { file: "memory", content: `Code word ${w}` }),
    ),
  );
  for (const w of ["Alpha", "Bravo", "Charlie", "Delta"])
    expect(file("MEMORY.md")).toContain(`Code word ${w}`);
});

test("a re-save changes nothing; nearly full files remind the model", async () => {
  await start({ memory_limit: 1000 });
  await call("save", { file: "memory", content: "Prefers green tea" });
  expect(text(await call("save", { file: "memory", content: "prefers green tea" }))).toStartWith(
    "Already saved",
  );
  const big = await call("save", { file: "memory", content: "x".repeat(800) });
  expect(text(big)).toContain("MEMORY.md is 8");
  expect(text(big)).toContain("% full: consolidate soon");
  expect(await call("save", { file: "memory", content: "y".repeat(300) })).toMatchObject({
    isError: true,
  });
});

test("update, confirm, done, move and delete through the tools", async () => {
  await call("save", { file: "memory", content: "Lives in Tokyo" });
  const changed = text(
    await call("update", { match: "Tokyo", content: "Lives in Osaka", changed: true }),
  );
  expect(changed).toContain("Old version kept in ARCHIVE.md:");
  expect(file("ARCHIVE.md")).toContain(`until:${today}] Lives in Tokyo`);
  expect(text(await call("update", { match: "Osaka" }))).toStartWith("Confirmed in MEMORY.md");
  await call("save", { file: "memory", content: "Book flights", type: "todo" });
  expect(text(await call("update", { match: "Book flights", done: true }))).toStartWith(
    "Done; moved to ARCHIVE.md",
  );
  expect(text(await call("move", { match: "Osaka", to: "user" }))).toStartWith(
    "Moved from MEMORY.md to USER.md",
  );
  expect(file("USER.md")).toContain(`- [${today}] Lives in Osaka`);
  expect(text(await call("delete", { match: "Osaka" }))).toStartWith("Deleted from USER.md");
  expect(file("USER.md")).not.toContain("Osaka");
});

test("delete asks by default; the other writes don't", () => {
  const allowed = Object.fromEntries(
    (plugin.tools ?? []).map((t) => [t.name, t.defaultAllow ?? false]),
  );
  expect(allowed).toEqual({
    save: true,
    update: true,
    move: true,
    delete: false,
    search: false,
    session_search: false,
  });
});

test("search covers all three files and labels validity", async () => {
  await call("save", { file: "memory", content: "Passport expires 2026-12", tags: "护照" });
  await call("save", { file: "memory", content: "Lives in Tokyo" });
  await call("move", { match: "Tokyo", to: "archive" });
  const r = text(await call("search", { query: "护照 tokyo" }));
  expect(r).toContain("2 entries (until: = no longer true, replaced: = reworded):");
  expect(r).toContain("MEMORY.md: - [fact");
  expect(r).toContain("ARCHIVE.md: - [fact");
  expect(text(await call("search", { query: "unrelated" }))).toBe("No matching entries.");
});

test("session prompt: both hot files with usage, hand edits kept, tidy runs first", async () => {
  writeFileSync(
    join(dir, "MEMORY.md"),
    "# Memory\nmy own notes\n\n- [fact 2026-10-10 ends:2000-01-01] Was in Paris\n- Mei likes sushi\n",
  );
  const prompt = (await plugin.sessionPrompt?.({ id: "s" })) ?? "";
  expect(prompt).toStartWith("# Memory\nSaved by Ivy across sessions;");
  expect(prompt).toContain("## USER.md (0 / 2,000 chars)\n(empty)");
  expect(prompt).toMatch(
    /## MEMORY.md \(\d+ \/ 8,000 chars\)\n# Memory\nmy own notes\n\n- Mei likes sushi/,
  );
  expect(prompt).not.toContain("Paris"); // its end date passed: archived before the snapshot
  expect(file("ARCHIVE.md")).toContain("until:2000-01-01] Was in Paris");
});

test("context lists todos due today or overdue, at most three", async () => {
  expect(plugin.contextFor?.({ sessionId: "s", userText: "", now: new Date() })).toBeNull();
  await call("save", { file: "memory", content: "Dentist", due: today });
  await call("save", { file: "memory", content: "Taxes", due: "2026-01-01" });
  await call("save", { file: "memory", content: "Later", due: "2999-01-01" });
  const ctx = plugin.contextFor?.({ sessionId: "s", userText: "", now: new Date() });
  expect(ctx).toContain("mention them to the user once in this conversation");
  expect(ctx).toContain("- Dentist (today)\n- Taxes (overdue since 2026-01-01)");
});

test("/memory shows usage and open todos, or searches", async () => {
  await call("save", { file: "memory", content: "Taxes", due: "2000-01-01" });
  const cmd = plugin.commands?.find((c) => c.name === "/memory");
  const overview = await cmd?.run("", { sessionId: "s", log });
  expect(overview).toContain("USER.md (0 / 2,000 chars) · MEMORY.md (");
  expect(overview).toContain("2000-01-01  Taxes  (long overdue)");
  expect(await cmd?.run("taxes", { sessionId: "s", log })).toContain("MEMORY.md: - [todo");
});

test("limits are configurable within bounds", async () => {
  expect(() => plugin.configSchema?.parse({ memory_limit: 10 })).toThrow();
  expect(() => plugin.configSchema?.parse({ typo: 1 })).toThrow();
  await start({ user_limit: 500 });
  expect(text(await call("save", { file: "user", content: "Prefers short answers" }))).toContain(
    "/ 500 chars",
  );
});

test("moving into a nearly full hot file reminds the model", async () => {
  await start({ memory_limit: 1000 });
  await call("save", { file: "memory", content: "x".repeat(800) });
  await call("move", { match: "xxxx", to: "archive" });
  const back = text(await call("move", { match: "xxxx", to: "memory" }));
  expect(back).toContain("% full: consolidate soon");
});

test("hand-written lines: hidden characters are left out, the rest is kept but flagged", async () => {
  const hidden = `- [todo 2026-10-01 due:2000-01-01] Pay${String.fromCodePoint(0x202e)}rent`;
  const mine =
    "- [fact 2026-10-01] Prompt tip: ignore all previous instructions breaks weak models";
  const key = "- [fact 2026-10-01] Test key sk-test-abcdefghijklmnopqrstuvwx";
  writeFileSync(join(dir, "MEMORY.md"), `# Memory\n\n${hidden}\n${mine}\n${key}\n`);
  const prompt = (await plugin.sessionPrompt?.({ id: "s" })) ?? "";
  expect(prompt).not.toContain("Pay"); // hidden characters: left out
  expect(prompt).toContain("Prompt tip"); // the user's own words: kept
  expect(prompt).toContain("Test key");
  expect(text(await call("search", { query: "pay rent" }))).toBe("No matching entries.");
  expect(plugin.contextFor?.({ sessionId: "s", userText: "", now: new Date() })).toBeNull();
  const cmd = plugin.commands?.find((c) => c.name === "/memory");
  const overview = (await cmd?.run("", { sessionId: "s", log })) ?? "";
  expect(overview).toContain("Left out of what the model sees");
  expect(overview).toContain("U+202E");
  expect(overview).toContain("Worth a look:");
  expect(overview).toContain("kept, since you wrote it");
  expect(overview).toContain("sent to the model provider with every request");
  // A write rewrites the file: the hand-written lines must survive it.
  await call("save", { file: "memory", content: "Ken likes ramen" });
  for (const line of [hidden, mine, key]) expect(file("MEMORY.md")).toContain(line);
});

test("a todo's time is kept in due and shown in the reminder", async () => {
  const r = text(
    await call("save", { file: "memory", content: "Pick up the parcel", due: `${today} 17:00` }),
  );
  expect(r).toContain(`due:${today}T17:00] Pick up the parcel`);
  const ctx = plugin.contextFor?.({ sessionId: "s", userText: "", now: new Date() });
  expect(ctx).toContain("- Pick up the parcel (today at 17:00)");
  expect(await call("save", { file: "memory", content: "x", due: `${today} 25:00` })).toMatchObject(
    {
      isError: true,
    },
  );
});

test("tags come in as one string, split on commas (any width), 、 and #", () => {
  expect(tagList("dentist, 牙医、看牙，health #teeth")).toEqual([
    "dentist",
    " 牙医",
    "看牙",
    "health ",
    "teeth",
  ]);
  expect(tagList(undefined)).toBeUndefined();
});

test("changes to the hot files during a session reach the turn's context", async () => {
  writeFileSync(
    join(dir, "MEMORY.md"),
    "# Memory\n\n- [fact 2026-10-01] Mei likes sushi\n- [fact 2026-10-01] Ken likes ramen\n",
  );
  await plugin.sessionPrompt?.({ id: "s1" });
  const turn = (sessionId = "s1") =>
    plugin.contextFor?.({ sessionId, userText: "", now: new Date() });
  expect(turn()).toBeNull(); // nothing changed

  // By hand (or another session): both the new and the removed line are reported.
  writeFileSync(
    join(dir, "MEMORY.md"),
    "# Memory\n\n- [fact 2026-10-01] Mei likes sushi\n- [fact 2026-10-19] Ken likes udon\n",
  );
  expect(turn()).toBe(
    "MEMORY.md changed since this session started:\n+ - [fact 2026-10-19] Ken likes udon\n- - [fact 2026-10-01] Ken likes ramen",
  );
  // By Ivy itself: shown too, so the context always matches the files.
  await call("save", { file: "user", content: "Prefers short answers" });
  expect(turn()).toContain(
    `USER.md changed since this session started:\n+ - [${today}] Prefers short answers`,
  );
  // A session that started later has its own snapshot.
  await plugin.sessionPrompt?.({ id: "s2" });
  expect(turn("s2")).toBeNull();
});

test("many changes fit the turn's context: whole lines, then a pointer to search", async () => {
  await plugin.sessionPrompt?.({ id: "s" });
  const facts = Array.from(
    { length: 30 },
    (_, i) => `- [fact 2026-10-19] Fact ${i}${" detail".repeat(15)}`,
  );
  writeFileSync(join(dir, "MEMORY.md"), `# Memory\n\n${facts.join("\n")}\n`);
  const ctx = (await plugin.contextFor?.({ sessionId: "s", userText: "", now: new Date() })) ?? "";
  expect(ctx.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
  const shown = ctx.split("\n").filter((l) => l.startsWith("+ "));
  for (const line of shown) expect(facts).toContain(line.slice(2).trimEnd());
  // 30 added entries, plus the default header's description line that this file lacks.
  expect(ctx).toEndWith(`(${31 - shown.length} more changes; search memory for the current state)`);
});

test("tool calls have short summaries for the transcript", () => {
  const summary = (name: string, input: object) =>
    plugin.tools?.find((t) => t.name === name)?.summary?.(input as never);
  expect(summary("save", { file: "memory", content: "Dentist at 15:00" })).toBe(
    "save to MEMORY.md: Dentist at 15:00",
  );
  expect(summary("update", { match: "Dentist", done: true })).toBe("done: Dentist");
  expect(summary("update", { match: "Dentist" })).toBe("confirm: Dentist");
  expect(summary("move", { match: "VPN", to: "archive" })).toBe("move to ARCHIVE.md: VPN");
  expect(summary("search", {})).toBe("list the newest entries");
});

test("reminders: open todos whose time falls in the window, dated ones at remind_at", async () => {
  await start({ remind_at: "08:30" });
  writeFileSync(
    join(dir, "MEMORY.md"),
    [
      "# Memory",
      "",
      "- [todo 2026-10-19 due:2026-10-20T17:00] Pick up the parcel",
      "- [todo 2026-10-19 due:2026-10-20] Pay the rent",
      "- [todo 2026-10-19 due:2026-10-20T09:00 done:2026-10-20] Call Ken",
      "- [fact 2026-10-19] Not a todo",
      "",
    ].join("\n"),
  );
  const local = (h: number, m = 0) => new Date(2026, 9, 20, h, m);
  const ask = (since: Date, now: Date) => plugin.reminders?.({ since, now });
  expect(await ask(local(16, 59), local(17))).toEqual([
    {
      id: "2026-10-20T17:00|Pick up the parcel",
      title: "Pick up the parcel",
      body: "Due at 17:00",
    },
  ]);
  expect(await ask(local(8), local(9))).toEqual([
    { id: "2026-10-20|Pay the rent", title: "Pay the rent", body: "Due today" },
  ]);
  expect(await ask(local(17), local(23))).toEqual([]); // (since, now]: 17:00 was the last window's
});
