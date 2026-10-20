import { existsSync, readFileSync } from "node:fs";
import type { Paths } from "./config.ts";
import type { PluginHost } from "./plugins.ts";
import RULES from "./prompts/rules.md" with { type: "text" };

export interface PromptPart {
  name: string;
  text: string;
}

/**
 * The system prompt, built per session and frozen for it, most stable part first:
 *
 * 1. rules.md: built-in operating and safety rules (always present, not user-editable)
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
  /** Frozen prompts by session id; several sessions may run at once (the daemon). */
  private readonly sessions = new Map<string, Promise<PromptPart[]>>();

  constructor(
    private readonly paths: Paths,
    private readonly plugins: PluginHost,
    /** For sessions started without instructions of their own. */
    private readonly interfaceInstructions = "",
  ) {}

  /**
   * Build the prompt for a session that starts now (startup, /new, /resume), even if built
   * before. `interfaceInstructions` describe the interface it starts in, when it differs
   * from the default (e.g. one-shot plain text).
   */
  start(
    sessionId: string,
    interfaceInstructions = this.interfaceInstructions,
  ): Promise<PromptPart[]> {
    const parts = this.build(sessionId, interfaceInstructions);
    this.sessions.set(sessionId, parts);
    return parts;
  }

  /** The prompt's sections for a session: the frozen ones, or built now if it hasn't started. */
  partsFor(sessionId: string): Promise<PromptPart[]> {
    return this.sessions.get(sessionId) ?? this.start(sessionId);
  }

  /** Drop a session's frozen prompt (it was closed); it is built afresh if it runs again. */
  end(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  async textFor(sessionId: string): Promise<string> {
    return (await this.partsFor(sessionId)).map((p) => p.text).join("\n\n");
  }

  private async build(sessionId: string, interfaceInstructions: string): Promise<PromptPart[]> {
    const parts = [{ name: "rules.md", text: RULES.trim() }];

    const soul = readOptional(this.paths.soul);
    if (soul) parts.push({ name: "SOUL.md", text: soul });

    if (interfaceInstructions.trim()) {
      parts.push({ name: "interface", text: `# Interface\n${interfaceInstructions.trim()}` });
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

function readOptional(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8").trim() : "";
}
