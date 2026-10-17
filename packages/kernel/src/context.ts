import { existsSync, readFileSync } from "node:fs";
import type { Paths } from "./config.ts";
import type { PluginHost } from "./plugins.ts";
import CORE from "./prompts/core.md" with { type: "text" };

export interface PromptPart {
  name: string;
  text: string;
}

/**
 * The system prompt, built per session and frozen for it, most stable part first:
 *
 * 1. core.md: built-in operating and safety rules (always present, not user-editable)
 * 2. SOUL.md: who Ivy is (data dir, optional)
 * 3. interface instructions: output format for the current UI (e.g. TUI vs. plain text)
 * 4. plugin instructions (static)
 * 5. plugins' session sections (`sessionPrompt`, e.g. the memory files USER.md and MEMORY.md)
 *
 * Files and session sections are read when a session starts, so hand edits apply after
 * /new. Within a session the bytes never change: any change would invalidate the prompt
 * cache. Per-turn data (like the time) goes into the turn's context instead.
 */
export class SystemPrompt {
  private current: { sessionId: string; parts: Promise<PromptPart[]> } | undefined;
  private built: { sessionId: string; parts: PromptPart[] } | undefined;

  constructor(
    private readonly paths: Paths,
    private readonly plugins: PluginHost,
    private readonly interfaceInstructions = "",
  ) {}

  /** Build the prompt for a session that starts now (startup, /new, /resume), even if built before. */
  start(sessionId: string): Promise<PromptPart[]> {
    const parts = this.build(sessionId);
    this.current = { sessionId, parts };
    void parts.then((p) => {
      if (this.current?.parts === parts) this.built = { sessionId, parts: p }; // not a stale build
    });
    return parts;
  }

  /** The prompt's sections for a session: the frozen ones, or built now if it hasn't started. */
  partsFor(sessionId: string): Promise<PromptPart[]> {
    return this.current?.sessionId === sessionId ? this.current.parts : this.start(sessionId);
  }

  async textFor(sessionId: string): Promise<string> {
    return joinParts(await this.partsFor(sessionId));
  }

  /** Sections already built for a session, without building them (for /status). */
  builtFor(sessionId: string): PromptPart[] | undefined {
    return this.built?.sessionId === sessionId ? this.built.parts : undefined;
  }

  private async build(sessionId: string): Promise<PromptPart[]> {
    const parts = [{ name: "core.md", text: CORE.trim() }];

    const soul = readOptional(this.paths.soul);
    if (soul) parts.push({ name: "SOUL.md", text: soul });

    if (this.interfaceInstructions.trim()) {
      parts.push({ name: "interface", text: `# Interface\n${this.interfaceInstructions.trim()}` });
    }

    const instructions = this.plugins.instructions();
    if (instructions.length > 0) {
      parts.push({
        name: "plugin instructions",
        text: `# Plugin instructions\n${instructions.join("\n\n")}`,
      });
    }

    for (const { id, text } of await this.plugins.sessionPrompts({ id: sessionId })) {
      parts.push({ name: `${id} (session)`, text });
    }
    return parts;
  }
}

export function joinParts(parts: PromptPart[]): string {
  return parts.map((p) => p.text).join("\n\n");
}

function readOptional(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8").trim() : "";
}
