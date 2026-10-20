// What Ivy's daemon and its clients (the TUI, the chat window) say to each other, over HTTP
// and Server-Sent Events on the daemon's Unix socket (DESIGN.md §5.7).
//
// What a client shows comes from the daemon: tool labels, history as entries, a permission
// prompt's choices. Clients only draw it. Only types are taken from the kernel, so a web
// client can use this package without bundling the kernel.

import type { PermissionChoice, RequestInfo, StopReason } from "@ivy/kernel";
import type { RiskLevel } from "@ivy/plugin-api";
import { z } from "zod";

/** Raised when a request or an event changes shape; a client that speaks another refuses. */
export const PROTOCOL_VERSION = 1;

/** GET /health */
export interface Health {
  ok: true;
  pid: number;
  startedAt: string;
  protocol: number;
}

// --- How replies are shown -------------------------------------------------------------

/**
 * How a session's replies are shown, chosen when it starts: `markdown` where they are
 * rendered (the TUI, the chat window), `plain` where they are printed or piped (one-shot
 * mode). The daemon tells the model how to write for it.
 */
export const DISPLAYS = ["markdown", "plain"] as const;
export type Display = (typeof DISPLAYS)[number];

// --- Sessions --------------------------------------------------------------------------

/** One thing in a session's transcript, as clients show it. */
export type Entry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; markdown: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      label: ToolLabel;
      input: unknown;
      /** Empty while the tool runs. */
      result: string;
      isError: boolean;
      /** The call hasn't finished yet (a turn in progress). */
      running?: boolean;
    };

/** A tool call in one line: the plugin, then what it does ("save: Dentist on Friday"). */
export interface ToolLabel {
  plugin: string;
  text: string;
}

/** A message the user sent, waiting for its turn or running. */
export interface Prompt {
  id: string;
  text: string;
}

/** Tokens: input includes cache reads and writes, i.e. the whole prompt sent each call. */
export interface Tokens {
  in: number;
  cached: number;
  out: number;
}

/** Tokens from one API response's usage. */
export function tokensFromUsage(u: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): Tokens {
  const cached = u.cache_read_input_tokens ?? 0;
  return {
    in: u.input_tokens + cached + (u.cache_creation_input_tokens ?? 0),
    cached,
    out: u.output_tokens,
  };
}

/** GET /sessions: most recently active first. */
export interface SessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** Messages the user sent. */
  turns: number;
  /** Start of the first one. */
  preview: string;
  /** A turn is running. */
  busy: boolean;
}

/** GET /sessions/:id: everything a client needs to show a session it opens. */
export interface SessionView {
  id: string;
  /** The transcript, with the running turn so far (its prompt, text and tool calls). */
  entries: Entry[];
  /** The prompt whose turn is running, if any. */
  running?: Prompt;
  /** Prompts waiting for the running turn to end, oldest first. */
  queue: Prompt[];
  tokens: Tokens;
  /** A permission prompt waiting for an answer, if any. */
  permission?: PermissionAsk;
}

/** A tool call waiting for the user's yes or no. */
export interface PermissionAsk {
  id: string;
  sessionId: string;
  name: string;
  label: ToolLabel;
  input: unknown;
  risk: RiskLevel;
  /** Why the user is asked, e.g. "write tool". */
  reason: string;
  /** Which answers to offer: "for this session" and "always" only where they take effect. */
  choices: Array<Exclude<PermissionChoice, "unanswered">>;
}

/** How a turn ended. */
export interface TurnEnd {
  stopReason: StopReason;
  steps: number;
  costUsd: number;
  error?: string;
}

// --- Events ----------------------------------------------------------------------------

/**
 * Everything that happens in a session, sent as `event: session` to every client; each
 * client keeps the ones for the sessions it shows. Within a session they arrive in order.
 */
export type SessionEvent = { sessionId: string } & SessionChange;

export type SessionChange =
  /** A message arrived: it runs now, or waits for the running turn. */
  | { type: "prompt"; prompt: Prompt }
  /** A waiting message was taken back, or dropped with an interrupt. */
  | { type: "prompt_withdrawn"; promptId: string }
  | { type: "turn_start"; prompt: Prompt }
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; label: ToolLabel; input: unknown }
  | { type: "tool_result"; id: string; name: string; content: string; isError: boolean }
  /** Something the user should know, e.g. a feature the endpoint doesn't support. */
  | { type: "notice"; text: string }
  /** The turn's plugin context (verbose view). */
  | { type: "context"; text: string }
  /** What is about to be sent for one model call (verbose view). */
  | { type: "request"; step: number; info: RequestInfo }
  | {
      type: "step";
      step: number;
      model: string;
      stopReason: string | null;
      tokens: Tokens;
      costUsd: number | null;
      latencyMs: number;
      traceFile?: string;
    }
  | { type: "permission"; ask: PermissionAsk }
  /** Answered by some client, or "unanswered" when no one did in time. */
  | { type: "permission_answered"; id: string; choice: PermissionChoice }
  | { type: "turn_end"; promptId: string; end: TurnEnd };

/** A reminder that came due, sent as `event: reminder` (see Reminder in plugin-api). */
export interface ReminderEvent {
  id: string;
  title: string;
  body?: string;
  at?: string;
  plugin: string;
}

/** GET /state: what the status bar shows. */
export interface DaemonState {
  /** "<provider>/<model id>" */
  model: string;
  /** The configured effort, and what this model is sent (undefined: none is sent). */
  effort: string;
  effortUsed?: string;
  /** Whether /model has anything to switch to. */
  canSwitchModel: boolean;
}

// --- Requests --------------------------------------------------------------------------

/** POST /sessions */
export const CreateSession = z.object({ display: z.enum(DISPLAYS).default("markdown") });
/** POST /sessions/:id/prompts */
export const SendPrompt = z.object({ text: z.string().trim().min(1) });
/** POST /sessions/:id/interrupt: stops the running turn; `clearQueue` also drops the waiting ones. */
export const Interrupt = z.object({ clearQueue: z.boolean().default(false) });
/** POST /permissions/:id */
export const AnswerPermission = z.object({ choice: z.enum(["once", "session", "always", "deny"]) });
/** PUT /model: switches now and saves it as the default. */
export const SetModel = z.object({ model: z.string().min(1) });
/** PUT /effort: likewise. */
export const SetEffort = z.object({ effort: z.string().min(1) });

/** A refused request: the status says what kind, the message says why. */
export interface ErrorBody {
  error: string;
}
