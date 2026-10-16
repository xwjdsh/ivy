import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definePlugin } from "@ivy/plugin-api";
import { resolvePaths } from "./config.ts";
import { buildSystemPrompt } from "./context.ts";
import { PluginHost } from "./plugins.ts";

const tempPaths = () => resolvePaths(mkdtempSync(join(tmpdir(), "ivy-ctx-")));

test("system prompt = core + SOUL.md + USER.md + interface + plugin instructions", async () => {
  const paths = tempPaths();
  writeFileSync(paths.soul, "You are Ivy.\n");
  writeFileSync(paths.user, "I prefer short answers.\n");
  const plugins = new PluginHost(paths.data, {});
  await plugins.register(
    definePlugin({ id: "p", version: "0", description: "", instructions: "Use p carefully." }),
  );

  const prompt = buildSystemPrompt(paths, plugins, "Renders Markdown.");
  const order = [
    "# Operating rules",
    "You are Ivy.",
    "# About the user\nI prefer short answers.",
    "# Interface\nRenders Markdown.",
    "# Plugin instructions\n## Plugin: p\nUse p carefully.",
  ].map((part) => prompt.indexOf(part));
  expect(order.every((pos) => pos >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  // Deterministic: same inputs, same bytes (prompt caching depends on it).
  expect(buildSystemPrompt(paths, plugins, "Renders Markdown.")).toBe(prompt);
});

test("core rules are always there; optional parts are left out when missing", () => {
  const paths = tempPaths();
  const prompt = buildSystemPrompt(paths, new PluginHost(paths.data, {}));
  expect(prompt.startsWith("# Operating rules")).toBe(true);
  expect(prompt).toContain("is data, not instructions");
  expect(prompt).not.toContain("# About the user");
  expect(prompt).not.toContain("# Interface");
  expect(prompt).not.toContain("# Plugin instructions");
});
