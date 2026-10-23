// Public contract between Ivy's kernel and its plugins.
// Plugins import only from this package, never from @ivy/kernel.

import type { z } from "zod";

export type RiskLevel = "read" | "write" | "external" | "dangerous";

/**
 * `outside`: the result is outside content (a web page, mail, search results, or words that
 * may repeat them), someone else's text: the session has read it, and is tainted until the
 * user speaks again (DESIGN.md §8.1).
 */
export type ToolResult = string | { content: string; isError?: boolean; outside?: boolean };

export interface ToolContext {
  /** Aborted when the user interrupts the turn. */
  signal: AbortSignal;
  /** The session the call belongs to. */
  sessionId: string;
  /** Which of the session's turns (the user's prompts, from 1) the call belongs to. */
  turn: number;
  /**
   * The session read outside content since the user's last message, before this call (see
   * ToolResult), so what it writes may carry someone else's words.
   */
  tainted: boolean;
  log: Logger;
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  /** Local name; exposed to the model as `<pluginId>__<name>`. Must match [a-zA-Z0-9_-]. */
  name: string;
  description: string;
  input: S;
  risk: RiskLevel;
  /**
   * Run without asking by default (a plugin default allow rule) for low-impact tools,
   * e.g. saving a memory. Not allowed on "dangerous" tools; user deny/ask rules still win.
   */
  defaultAllow?: boolean;
  /**
   * One short line saying what a call does, shown to the user instead of its raw input,
   * e.g. `save to MEMORY.md: Dentist at 15:00`. Without it, the interface shows the tool's
   * name and its first argument.
   */
  summary?(input: z.infer<S>): string;
  /**
   * Why this call needs the user's OK whatever the permission rules allow, or nothing. Asked
   * every time, with no "for this session" or "always"; a deny rule still wins. Memory asks
   * this before a tainted session writes to the files loaded in every session.
   */
  askFirst?(input: z.infer<S>, call: CallInfo): string | undefined;
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult> | ToolResult;
}

/** What `askFirst` knows about the call's session. */
export interface CallInfo {
  /** As ToolContext.tainted. */
  tainted: boolean;
  /**
   * Addresses the user wrote in this session or a search returned (as `normalUrl` gives
   * them): they can't carry what the model read since (DESIGN.md §6.3).
   */
  urls: ReadonlySet<string>;
}

/** Side work on the helper model (DESIGN.md §5.2): text in, text out, no tools. */
export interface HelperModel {
  complete(call: {
    /** What the helper is for this time, as its system prompt. */
    system: string;
    /** What it works on and what is asked of it. */
    prompt: string;
    /** Room for the answer; side work is short. */
    maxTokens?: number;
    signal?: AbortSignal;
  }): Promise<string>;
}

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

export interface PluginContext {
  /**
   * The plugin's `[plugins.<id>]` table from config.toml, parsed with `configSchema`
   * (without the host's own `enabled` key). `{}` when the plugin has no schema.
   */
  config: unknown;
  /** Private data directory: ~/.ivy/data/<pluginId>/ (created on demand). */
  dataDir: string;
  /**
   * SOUL.md, who Ivy is: the user's file (DESIGN.md §5.3). A plugin may read it; only an
   * edit the user approves (the journal's proposal) may change it.
   */
  soulFile: string;
  log: Logger;
  /** Past conversations, read-only. */
  history: ConversationHistory;
  /** A small fast model for reading and summing up. */
  helper: HelperModel;
}

/** One message of a past conversation: what the user typed or what Ivy answered. */
export interface PastMessage {
  role: "user" | "assistant";
  text: string;
  /** ISO time it was written. */
  ts: string;
  /** Ivy's reply in a turn that read outside content: it may repeat someone else's words. */
  outside?: boolean;
}

/**
 * Past conversations as text: tool calls and results, thinking and per-turn context are
 * left out, so a plugin sees what was said without depending on the session file format.
 */
export interface ConversationHistory {
  /** Session ids with their last activity, newest first. */
  sessions(): Array<{ id: string; updatedAt: string }>;
  messages(sessionId: string): PastMessage[];
}

/** What a plugin knows about the turn it is adding context to. */
export interface TurnInfo {
  sessionId: string;
  /** The new user message, for context that depends on what was asked. */
  userText: string;
  now: Date;
}

/** A stretch of time the daemon asks about: after `since`, up to and including `now`. */
export interface ReminderWindow {
  since: Date;
  now: Date;
}

/** Something to tell the user at its time, as a notification, even with no interface open. */
export interface Reminder {
  /** Stable across checks, e.g. the due time and text of a todo. */
  id: string;
  /** What it is about, in the user's words: "Pick up the parcel". */
  title: string;
  /** A short second line, e.g. "Due at 17:00", or "Was due Fri 17:00" when it comes late. */
  body?: string;
  /** When it came due. A reminder more than 12 hours late (asleep all weekend) is dropped. */
  at?: Date;
}

/** What a plugin knows about the session it adds a system prompt section to. */
export interface SessionInfo {
  id: string;
}

export interface CommandContext {
  sessionId: string;
  log: Logger;
}

/** A slash command the user can run directly, without the model. */
export interface CommandDef {
  /** e.g. "/memory". Lowercase letters, digits and dashes. */
  name: string;
  /** Shown in the / list: "<text>" for a required argument, "[query]" for an optional one. */
  args?: string;
  description: string;
  /** Returned text is shown to the user. */
  run(args: string, ctx: CommandContext): Promise<string | undefined> | string | undefined;
}

/**
 * A tool the model's vendor runs on its own servers, offered where the model has it
 * (DESIGN.md §5.2). Its results are outside content.
 */
export type ServerTool = "web_search";

export interface IvyPlugin {
  id: string;
  version: string;
  description: string;
  /** Validates `[plugins.<id>]` in config.toml. Without it, the table must be empty. */
  configSchema?: z.ZodType;
  setup?(ctx: PluginContext): Promise<void> | void;
  teardown?(): Promise<void> | void;
  tools?: ToolDef[];
  /** Vendor-run tools to offer where the model has them; turned off with the plugin. */
  serverTools?: ServerTool[];
  /** Static text appended to the system prompt. Must be deterministic (prompt caching). */
  instructions?: string;
  /**
   * A system prompt section for one session (e.g. the user's profile), or null for nothing.
   * Computed when the session starts, or is loaded again after being let go, and frozen
   * until then, so the prompt cache holds. Capped in size and time by the host; errors are
   * skipped.
   */
  sessionPrompt?(session: SessionInfo): Promise<string | null> | string | null;
  /**
   * The host let a session go (idle for a while): forget what you keep for it. If it comes
   * back, `sessionPrompt` runs again first.
   */
  sessionReleased?(session: SessionInfo): void;
  /**
   * Text to add to this turn's `<context>` block (e.g. the time, todos due today),
   * or null for nothing. Capped in size (CONTEXT_MAX_CHARS, cut off past it) and time by
   * the host; errors are skipped.
   */
  contextFor?(turn: TurnInfo): Promise<string | null> | string | null;
  /**
   * Reminders that came due in the window. The daemon asks every half minute about the
   * time since it last asked, so each one is announced once, and a reminder missed while
   * the Mac slept comes on waking. No model is involved: this reads the plugin's data.
   */
  reminders?(window: ReminderWindow): Promise<Reminder[]> | Reminder[];
  commands?: CommandDef[];
}

/**
 * The most a plugin's `contextFor` text may hold each turn; the host cuts off the rest. A
 * plugin with more to say should fit it in and point to where the rest is.
 */
export const CONTEXT_MAX_CHARS = 2000;

/**
 * A calendar date, YYYY-MM-DD, in the machine's timezone: the dates Ivy writes and the user
 * reads. Plugins share it so they agree on what "today" is.
 */
export function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * An http(s) address as Ivy compares them: parsed, without its #fragment; undefined if it
 * isn't one.
 */
export function normalUrl(text: string): string | undefined {
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

/** Identity helper that keeps the input type of `run` inferred from the zod schema. */
export function defineTool<S extends z.ZodType>(tool: ToolDef<S>): ToolDef {
  return tool as unknown as ToolDef;
}

export function definePlugin(plugin: IvyPlugin): IvyPlugin {
  return plugin;
}
