import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IvyPlugin, ToolResult } from "@ivy/plugin-api";
import { createMemoryPlugin, localDate } from "./index.ts";

let dir: string;
let plugin: IvyPlugin;
const today = localDate(new Date());
const log = { debug() {}, info() {}, warn() {}, error() {} };

async function start(settings: Record<string, unknown> = {}) {
  plugin = createMemoryPlugin();
  const config = plugin.configSchema?.parse(settings);
  await plugin.setup?.({ config, dataDir: dir, log });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ivy-mem-"));
  await start();
});

const call = (name: string, input: object): Promise<ToolResult> => {
  const tool = plugin.tools?.find((t) => t.name === name);
  if (!tool) throw new Error(name);
  return Promise.resolve(tool.run(input as never, { signal: new AbortController().signal, log }));
};
const text = (r: ToolResult) => (typeof r === "string" ? r : r.content);
const file = (name: string) => readFileSync(join(dir, name), "utf8");

test("save writes MEMORY.md with its header and reports usage", async () => {
  const r = await call("save", {
    file: "memory",
    content: "Dentist at 15:00",
    due: "2026-10-21",
    tags: ["牙医"],
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
  expect(allowed).toEqual({ save: true, update: true, move: true, delete: false, search: false });
});

test("search covers all three files and labels validity", async () => {
  await call("save", { file: "memory", content: "Passport expires 2026-12", tags: ["护照"] });
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
  expect(ctx).toBe("Due: Dentist (today)\nDue: Taxes (overdue since 2026-01-01)");
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
