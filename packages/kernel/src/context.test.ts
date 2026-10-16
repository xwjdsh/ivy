import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definePlugin } from "@ivy/plugin-api";
import { resolvePaths } from "./config.ts";
import { buildSystemPrompt } from "./context.ts";
import { PluginHost } from "./plugins.ts";

const tempPaths = () => resolvePaths(mkdtempSync(join(tmpdir(), "ivy-ctx-")));

test("system prompt = SOUL.md + USER.md + plugin instructions", async () => {
  const paths = tempPaths();
  writeFileSync(paths.soul, "You are Ivy.\n");
  writeFileSync(paths.user, "I prefer short answers.\n");
  const plugins = new PluginHost(paths.data, {});
  await plugins.register(
    definePlugin({ id: "p", version: "0", description: "", instructions: "Use p carefully." }),
  );

  const prompt = buildSystemPrompt(paths, plugins);
  expect(prompt).toBe(
    "You are Ivy.\n\n# About the user\nI prefer short answers.\n\n# Plugin instructions\n## Plugin: p\nUse p carefully.",
  );
  // Deterministic: same inputs, same bytes (prompt caching depends on it).
  expect(buildSystemPrompt(paths, plugins)).toBe(prompt);
});

test("missing files are left out, and nothing at all gives an empty prompt", () => {
  const paths = tempPaths();
  expect(buildSystemPrompt(paths, new PluginHost(paths.data, {}))).toBe("");
  writeFileSync(paths.user, "Hi");
  expect(buildSystemPrompt(paths, new PluginHost(paths.data, {}))).toBe("# About the user\nHi");
});
