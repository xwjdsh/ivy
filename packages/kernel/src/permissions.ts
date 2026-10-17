import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RiskLevel } from "@ivy/plugin-api";
import { createLogger } from "./log.ts";

export type Decision = "allow" | "deny" | "ask";

/** What the user picked in a permission prompt. */
export type PermissionChoice = "once" | "session" | "always" | "deny";

export interface PermissionRules {
  allow: string[];
  ask: string[];
  deny: string[];
}

export interface DecisionWithReason {
  decision: Decision;
  /** Why, in a few words; shown in the permission prompt and /status. */
  reason: string;
  /**
   * For "ask": whether "for this session" / "always" would have any effect. False for
   * dangerous tools and ask rules, which are checked before every allow.
   */
  canRemember: boolean;
}

/**
 * Who may run a tool without asking. Checked in this order; the first match wins:
 *
 * 1. `deny` rules (config.toml): rejected, never asked.
 * 2. `ask` rules (config.toml): always asked, whatever the tool's declared risk. This is
 *    the user's answer to a plugin that labels a risky tool "read".
 * 3. `dangerous` tools: always asked; allow rules and "remember" choices don't apply.
 * 4. Allow: `allow` rules (config.toml), learned rules (permissions.json, from "Always"),
 *    plugin defaults (`defaultAllow` on low-impact tools), and "for this session" choices.
 * 5. The risk level's default: `read` runs, everything else is asked.
 *
 * Rules are tool-name globs; `*` matches anything ("memory__*").
 */
export class Permissions {
  private readonly session = new Set<string>();
  private learned: string[];
  private readonly log = createLogger("permissions");

  constructor(
    private readonly rules: PermissionRules,
    /** ~/.ivy/permissions.json: allow rules saved from the dialog; Ivy-owned. */
    private readonly learnedFile: string,
    /** Whether the owning plugin marks this tool as safe to run without asking. */
    private readonly pluginDefault: (tool: string) => boolean = () => false,
  ) {
    this.learned = this.load();
  }

  decide(tool: string, risk: RiskLevel): DecisionWithReason {
    const fixed = (decision: Decision, reason: string) => ({
      decision,
      reason,
      canRemember: false,
    });
    if (matchesAny(tool, this.rules.deny)) return fixed("deny", "deny rule");
    if (matchesAny(tool, this.rules.ask)) return fixed("ask", "ask rule");
    if (risk === "dangerous") return fixed("ask", "dangerous tool");
    if (matchesAny(tool, this.rules.allow)) return fixed("allow", "allow rule");
    if (matchesAny(tool, this.learned)) return fixed("allow", "allowed always");
    if (this.pluginDefault(tool)) return fixed("allow", "plugin default");
    if (this.session.has(tool)) return fixed("allow", "allowed for this session");
    if (risk === "read") return fixed("allow", "read-only");
    return { decision: "ask", reason: `${risk} tool`, canRemember: true };
  }

  /**
   * Apply what the user picked for an "ask" decision; returns whether this call may run.
   * "session" / "always" count as "once" when the decision can't be remembered, whatever
   * the interface offered.
   */
  remember(tool: string, choice: PermissionChoice, asked: DecisionWithReason): boolean {
    if (choice === "deny") return false;
    if (!asked.canRemember) return true;
    if (choice === "session") this.session.add(tool);
    if (choice === "always" && !this.learned.includes(tool)) {
      this.learned.push(tool);
      this.save();
    }
    return true;
  }

  /** "For this session" choices end with the session (/new, /resume). */
  clearSession(): void {
    this.session.clear();
  }

  /** Rules in effect, for /status. */
  summary(): PermissionRules & { learned: string[] } {
    return { ...this.rules, learned: [...this.learned] };
  }

  private load(): string[] {
    try {
      if (!existsSync(this.learnedFile)) return [];
      const data = JSON.parse(readFileSync(this.learnedFile, "utf8")) as { allow?: unknown };
      return Array.isArray(data.allow) ? data.allow.filter((x) => typeof x === "string") : [];
    } catch (err) {
      this.log.warn(`ignoring unreadable ${this.learnedFile}`, String(err));
      return [];
    }
  }

  /** Merge with the file first, so rules saved meanwhile by another Ivy process survive. */
  private save(): void {
    this.learned = [...new Set([...this.load(), ...this.learned])];
    try {
      mkdirSync(dirname(this.learnedFile), { recursive: true });
      writeFileSync(this.learnedFile, `${JSON.stringify({ allow: this.learned }, null, 2)}\n`);
    } catch (err) {
      this.log.warn(`could not save ${this.learnedFile}`, String(err));
    }
  }
}

export function matchesAny(name: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(name));
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}
