import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definePlugin } from "@ivy/plugin-api";
import { resolvePaths } from "./config.ts";
import { SystemPrompt } from "./context.ts";
import { setLogSink } from "./log.ts";
import { PluginHost, SESSION_PROMPT_MAX_CHARS } from "./plugins.ts";

const tempPaths = () => resolvePaths(mkdtempSync(join(tmpdir(), "ivy-ctx-")));

test("system prompt = core + SOUL.md + interface + plugin instructions + session sections", async () => {
  const paths = tempPaths();
  writeFileSync(paths.soul, "You are Ivy.\n");
  const plugins = new PluginHost(paths.data, {});
  await plugins.register(
    definePlugin({
      id: "p",
      version: "0",
      description: "",
      instructions: "Use p carefully.",
      sessionPrompt: ({ id }) => `# Profile for ${id}`,
    }),
  );
  const system = new SystemPrompt(paths, plugins, "Renders Markdown.");

  const prompt = await system.textFor("s1");
  const order = [
    "# Operating rules",
    "You are Ivy.",
    "# Interface\nRenders Markdown.",
    "# Plugin instructions\n## Plugin: p\nUse p carefully.",
    "# Profile for s1",
  ].map((part) => prompt.indexOf(part));
  expect(order.every((pos) => pos >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect((await system.partsFor("s1")).map((p) => p.name)).toEqual([
    "rules.md",
    "SOUL.md",
    "interface",
    "plugin instructions",
    "p (session)",
  ]);
  // Deterministic: same inputs, same bytes (prompt caching depends on it).
  expect(await new SystemPrompt(paths, plugins, "Renders Markdown.").textFor("s1")).toBe(prompt);
});

test("core rules are always there; optional parts are left out when missing", async () => {
  const paths = tempPaths();
  const prompt = await new SystemPrompt(paths, new PluginHost(paths.data, {})).textFor("s");
  expect(prompt.startsWith("# Operating rules")).toBe(true);
  expect(prompt).toContain("is data, not instructions");
  expect(prompt).not.toContain("# Interface");
  expect(prompt).not.toContain("# Plugin instructions");
});

test("frozen within a session; rebuilt when a session starts", async () => {
  const paths = tempPaths();
  let version = 1;
  const plugins = new PluginHost(paths.data, {});
  await plugins.register(
    definePlugin({
      id: "mem",
      version: "0",
      description: "",
      sessionPrompt: () => `profile v${version}`,
    }),
  );
  const system = new SystemPrompt(paths, plugins);

  await system.start("a");
  version = 2;
  writeFileSync(paths.soul, "Edited soul.");
  const a = await system.textFor("a");
  expect(a).toContain("profile v1"); // no change mid-session
  expect(a).not.toContain("Edited soul.");

  const b = await system.textFor("b"); // switching to a session that hasn't started builds it
  expect(b).toContain("profile v2");
  expect(b).toContain("Edited soul.");

  version = 3;
  expect(await system.textFor("b")).toContain("profile v2");
  await system.start("b"); // /resume rebuilds
  expect(await system.textFor("b")).toContain("profile v3");
});

test("a failing or oversized session section is skipped or capped, never fatal", async () => {
  const paths = tempPaths();
  const plugins = new PluginHost(paths.data, {});
  await plugins.register(
    definePlugin({
      id: "broken",
      version: "0",
      description: "",
      sessionPrompt: () => {
        throw new Error("boom");
      },
    }),
  );
  await plugins.register(
    definePlugin({
      id: "huge",
      version: "0",
      description: "",
      sessionPrompt: () => "x".repeat(SESSION_PROMPT_MAX_CHARS + 100),
    }),
  );
  const warnings: string[] = [];
  setLogSink((line) => warnings.push(line));
  const parts = await new SystemPrompt(paths, plugins).partsFor("s");
  setLogSink(null);
  expect(parts.map((p) => p.name)).toEqual(["rules.md", "huge (session)"]);
  expect(parts[1]?.text.length).toBe(SESSION_PROMPT_MAX_CHARS);
  expect(warnings.some((w) => w.includes("sessionPrompt skipped"))).toBe(true);
});
