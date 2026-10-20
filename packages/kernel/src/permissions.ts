import type { RiskLevel } from "@ivy/plugin-api";
import { createLogger, errorMessage } from "./log.ts";

export type Decision = "allow" | "deny" | "ask";

/**
 * What the user picked in a permission prompt; "unanswered" when no one did in time (the
 * daemon, with no client there to ask).
 */
export type PermissionChoice = "once" | "session" | "always" | "deny" | "unanswered";

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
 * 4. Allow: `allow` rules (config.toml; *Always* in the prompt adds one there), plugin
 *    defaults (`defaultAllow` on low-impact tools), and "for this session" choices, kept
 *    per session, so several sessions can run side by side (the daemon).
 * 5. The risk level's default: `read` runs, everything else is asked.
 *
 * Rules are tool-name globs; `*` matches anything ("memory__*").
 */
export class Permissions {
  /** "For this session" choices, by session id. */
  private readonly sessions = new Map<string, Set<string>>();
  private readonly log = createLogger("permissions");

  constructor(
    private readonly rules: PermissionRules,
    /** Saves an *Always* choice, i.e. adds an allow rule to config.toml. */
    private readonly saveAllow: (tool: string) => void = () => {},
    /** Whether the owning plugin marks this tool as safe to run without asking. */
    private readonly pluginDefault: (tool: string) => boolean = () => false,
  ) {}

  decide(tool: string, risk: RiskLevel, sessionId: string): DecisionWithReason {
    const fixed = (decision: Decision, reason: string) => ({
      decision,
      reason,
      canRemember: false,
    });
    if (matchesAny(tool, this.rules.deny)) return fixed("deny", "deny rule");
    if (matchesAny(tool, this.rules.ask)) return fixed("ask", "ask rule");
    if (risk === "dangerous") return fixed("ask", "dangerous tool");
    if (matchesAny(tool, this.rules.allow)) return fixed("allow", "allow rule");
    if (this.pluginDefault(tool)) return fixed("allow", "plugin default");
    if (this.sessions.get(sessionId)?.has(tool)) return fixed("allow", "allowed for this session");
    if (risk === "read") return fixed("allow", "read-only");
    return { decision: "ask", reason: `${risk} tool`, canRemember: true };
  }

  /**
   * Apply what the user picked for an "ask" decision; returns whether this call may run.
   * "session" / "always" count as "once" when the decision can't be remembered, whatever
   * the interface offered.
   */
  remember(
    tool: string,
    choice: PermissionChoice,
    asked: DecisionWithReason,
    sessionId: string,
  ): boolean {
    if (choice === "deny" || choice === "unanswered") return false;
    if (!asked.canRemember) return true;
    if (choice === "session") {
      const allowed = this.sessions.get(sessionId) ?? new Set<string>();
      this.sessions.set(sessionId, allowed.add(tool));
    }
    if (choice === "always" && !matchesAny(tool, this.rules.allow)) {
      this.rules.allow.push(tool);
      try {
        this.saveAllow(tool);
      } catch (err) {
        // Still allowed for this run; the user sees why it wasn't saved in the log.
        this.log.warn(`could not save the allow rule for ${tool}`, errorMessage(err));
      }
    }
    return true;
  }

  /** Forget a session's "for this session" choices (it was closed, or ended). */
  endSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Rules in effect, for /status. */
  summary(): PermissionRules {
    return { allow: [...this.rules.allow], ask: [...this.rules.ask], deny: [...this.rules.deny] };
  }
}

export function matchesAny(name: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(name));
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}
