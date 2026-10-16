import { existsSync, readFileSync } from "node:fs";
import type { Paths } from "./config.ts";
import type { PluginHost } from "./plugins.ts";
import CORE from "./prompts/core.md" with { type: "text" };

/**
 * Build the system prompt, most stable part first:
 *
 * 1. core.md: built-in operating and safety rules (always present, not user-editable)
 * 2. SOUL.md: who Ivy is (data dir, optional)
 * 3. USER.md: who the user is (data dir, optional)
 * 4. interface instructions: output format for the current UI (e.g. TUI vs. plain text)
 * 5. plugin instructions
 *
 * It must be deterministic for a given set of inputs: any byte change invalidates
 * the prompt cache. Volatile data (like the time) comes from tools, never from here.
 */
export function buildSystemPrompt(
  paths: Paths,
  plugins: PluginHost,
  interfaceInstructions = "",
): string {
  const sections = [CORE.trim()];

  const soul = readOptional(paths.soul);
  if (soul) sections.push(soul);

  const user = readOptional(paths.user);
  if (user) sections.push(`# About the user\n${user}`);

  if (interfaceInstructions.trim()) sections.push(`# Interface\n${interfaceInstructions.trim()}`);

  const instructions = plugins.instructions();
  if (instructions.length > 0) sections.push(`# Plugin instructions\n${instructions.join("\n\n")}`);

  return sections.join("\n\n");
}

function readOptional(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8").trim() : "";
}
