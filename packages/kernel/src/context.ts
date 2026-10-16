import { existsSync, readFileSync } from "node:fs";
import type { Paths } from "./config.ts";
import type { PluginHost } from "./plugins.ts";

/**
 * Build the system prompt from the data dir's SOUL.md and USER.md plus plugin
 * instructions. Missing files are skipped; the result may be empty.
 *
 * It must be deterministic for a given set of inputs: any byte change invalidates
 * the prompt cache. Volatile data (like the time) comes from tools, never from here.
 */
export function buildSystemPrompt(paths: Paths, plugins: PluginHost): string {
  const sections: string[] = [];

  const soul = readOptional(paths.soul);
  if (soul) sections.push(soul);

  const user = readOptional(paths.user);
  if (user) sections.push(`# About the user\n${user}`);

  const instructions = plugins.instructions();
  if (instructions.length > 0) sections.push(`# Plugin instructions\n${instructions.join("\n\n")}`);

  return sections.join("\n\n");
}

function readOptional(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8").trim() : "";
}
