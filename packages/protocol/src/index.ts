// What Ivy's daemon and its clients (the TUI, the chat window) say to each other, over HTTP
// and Server-Sent Events on the daemon's Unix socket (DESIGN.md §5.7).
//
// What a client shows comes from the daemon: tool labels, history as entries, a permission
// prompt's choices. Clients only draw it. Only types are taken from the kernel, so a web
// client can use this package without bundling the kernel.
//
// The macOS app (Go, app/events.go) reads part of it too: /health, /events?notify=1 and
// the reminder event. Change those here and there together.

import type { PermissionChoice, RequestInfo, StopReason, TokenCounts } from "@ivy/kernel";
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
  /** Which code it runs: a build id, or in development a fingerprint of the source. */
  code: string;
  /** Started by `ivy` when none ran: it exits once idle, and a newer `ivy` may replace it. */
  onDemand: boolean;
  /** Exiting: a client waits for it to go and starts a new one. */
  draining: boolean;
}

/** GET /events?notify=1: this client shows reminders (the app), so they are announced. */
export const NOTIFY_PARAM = "notify";

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
  /** `images`: sent with it, by name (GET /sessions/:id/images/:name). */
  | { kind: "user"; text: string; images?: string[] }
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
      /** The result is outside content (a search, a page read): where Ivy's words came from. */
      outside?: boolean;
      /** The call hasn't finished yet (a turn in progress). */
      running?: boolean;
    };

/** A tool call in one line: the plugin, then what it does ("save: Dentist on Friday"). */
export interface ToolLabel {
  plugin: string;
  text: string;
  /**
   * What of Ivy's own it acts on, if only that (the plugin API's ToolDef.own), and the tool
   * may fold for it: never for an external or dangerous tool.
   */
  own?: "records" | "journal";
}

/** A message the user sent, waiting for its turn or running. */
export interface Prompt {
  id: string;
  text: string;
  /** Images sent with it, by name, as with an entry. */
  images?: string[];
}

/** Tokens: input includes cache reads and writes, i.e. the whole prompt sent each call. */
export interface Tokens {
  in: number;
  cached: number;
  out: number;
}

/** One model call's usage, or a sum of them: input excludes cache reads and writes. */
export type Usage = TokenCounts;

export function tokensFromUsage(u: Usage): Tokens {
  return { in: u.input + u.cacheRead + u.cacheWrite, cached: u.cacheRead, out: u.output };
}

export const addTokens = (a: Tokens, b: Tokens): Tokens => ({
  in: a.in + b.in,
  cached: a.cached + b.cached,
  out: a.out + b.out,
});

/** 1234 → "1.2k", 1234567 → "1.2M". */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** "3.5k in (3.4k cached) / 32 out" */
export function formatTokens(t: Tokens): string {
  const cached = t.cached > 0 ? ` (${compact(t.cached)} cached)` : "";
  return `${compact(t.in)} in${cached} / ${compact(t.out)} out`;
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
  /** Off the record: kept nowhere, deleted once let go. */
  offRecord?: true;
  /** Started by Ivy, writing first. */
  fromIvy?: true;
}

/** GET /sessions/:id: everything a client needs to show a session it opens. */
export interface SessionView {
  id: string;
  /**
   * The transcript, with the running turn so far: its prompt, its finished text, and its
   * tool calls (`running` while one is).
   */
  entries: Entry[];
  /** The running turn's text still being written, after the last entry. */
  streaming?: string;
  /** The prompt whose turn is running, if any. */
  running?: Prompt;
  /** Prompts waiting for the running turn to end, oldest first. */
  queue: Prompt[];
  tokens: Tokens;
  /** A permission prompt waiting for an answer, if any. */
  permission?: PermissionAsk;
  /** Off the record: kept nowhere, deleted once let go. */
  offRecord?: true;
}

/** What a client may answer to a permission prompt. */
export const PERMISSION_ANSWERS = ["once", "session", "always", "deny"] as const;
export type PermissionAnswer = (typeof PERMISSION_ANSWERS)[number];

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
  choices: PermissionAnswer[];
}

/** How a turn ended. */
export interface TurnEnd {
  stopReason: StopReason;
  steps: number;
  costUsd: number;
  error?: string;
}

const STOP_NOTES: Partial<Record<StopReason, string>> = {
  interrupted: "Interrupted",
  refusal: "The model declined this request",
  max_steps: "Stopped: too many steps in one turn",
  max_tokens: "Response hit max_tokens",
};

/** What a client says of a turn that didn't end as usual (the error, an interrupt), if anything. */
export function stopNote(end: TurnEnd): string | undefined {
  return end.stopReason === "error"
    ? `Error: ${end.error ?? "unknown"}`
    : STOP_NOTES[end.stopReason];
}

// --- Events ----------------------------------------------------------------------------

/**
 * Everything that happens in a session, sent as `event: session` to every client; each
 * client keeps the ones for the sessions it shows. Within a session they arrive in order.
 */
export type SessionEvent = { sessionId: string } & SessionChange;

export type SessionChange =
  /** A conversation Ivy started herself, her message first (DESIGN.md §11, M3). */
  | { type: "started" }
  /** A message arrived: it runs now, or waits for the running turn. */
  | { type: "prompt"; prompt: Prompt }
  /** A waiting message was taken back, or dropped with an interrupt. */
  | { type: "prompt_withdrawn"; promptId: string }
  | { type: "turn_start"; prompt: Prompt }
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; label: ToolLabel; input: unknown }
  | {
      type: "tool_result";
      id: string;
      name: string;
      label: ToolLabel;
      content: string;
      isError: boolean;
      outside?: boolean;
    }
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
      usage: Usage;
      costUsd: number | null;
      latencyMs: number;
      traceFile?: string;
    }
  | { type: "permission"; ask: PermissionAsk }
  /** Answered by some client, or "unanswered" when no one did in time. */
  | { type: "permission_answered"; id: string; choice: PermissionChoice }
  | { type: "turn_end"; promptId: string; end: TurnEnd };

/**
 * Read the event stream (Server-Sent Events as the daemon writes them: an `event:` line
 * and one `data:` line each) until it ends, calling `onEvent` with each event's type and
 * data; heartbeats (comment lines) are skipped.
 */
export async function readEvents(
  stream: ReadableStream<Uint8Array>,
  onEvent: (type: string, data: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader(); // not `for await`: WebKit's streams may lack it
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const type = /^event: (.*)$/m.exec(event)?.[1];
      if (type) onEvent(type, /^data: (.*)$/m.exec(event)?.[1] ?? "");
    }
  }
}

/** A reminder that came due, sent as `event: reminder` (see Reminder in plugin-api). */
// Mirrored by `reminder` in app/events.go, which reads id, title, body and plugin.
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
  /** The helper model for side work, "<provider>/<model id>"; "" when side work runs on `model`. */
  helperModel: string;
  /** Ivy writes first, from follow-ups (DESIGN.md §11, M3). */
  writesFirst: boolean;
  /** The effort levels /effort offers. */
  efforts: string[];
  /** Plugins loaded, and the tools they offer. */
  plugins: number;
  tools: number;
}

/** A provider as the settings page shows it. Never its key: only where one is kept. */
export interface ProviderInfo {
  name: string;
  /** The protocol: "anthropic" (the Messages API) or "openai" (Chat Completions). */
  type: string;
  base_url: string;
  /** The vendor's own API for its protocol (by `base_url`). */
  official: boolean;
  /** Models offered on it; empty: whatever its endpoint lists. */
  models: string[];
  /** Where its API key is: config.toml, the Keychain, or nowhere yet. */
  key: "config" | "keychain" | "none";
  /** The model in use is one of its: it can't be removed. */
  inUse: boolean;
}

/** GET /settings: what the settings page shows, apart from the app's own settings. */
export interface Settings {
  providers: ProviderInfo[];
  /** Whether keys can go to the Keychain here (macOS). */
  keychain: boolean;
  permissions: { allow: string[]; ask: string[]; deny: string[] };
  tools: Array<{ name: string; risk: string; defaultAllow: boolean }>;
  plugins: Array<{
    id: string;
    description: string;
    enabled: boolean;
    config: Record<string, unknown>;
  }>;
  paths: { home: string; config: string };
  /** Which code the daemon runs. */
  code: string;
}

const ProviderName = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, "A provider's name is letters, digits, - and _");
const BaseUrl = z.union([z.url(), z.literal("")]);
/** POST /providers: add one, its key (if any) to the Keychain. */
export const AddProvider = z.object({
  name: ProviderName,
  type: z.string().default("anthropic"),
  base_url: BaseUrl.default(""),
  models: z.array(z.string().min(1)).default([]),
  key: z.string().default(""),
});
/** PUT /providers/:name: change its endpoint or the models offered on it. */
export const UpdateProvider = z.object({
  base_url: BaseUrl.optional(),
  models: z.array(z.string().min(1)).optional(),
});
/**
 * PUT /providers/:name/key: its key, to the Keychain; one in config.toml moves out. Without
 * a key, the one in config.toml moves to the Keychain as it is.
 */
export const SetKey = z.object({ key: z.string().trim().min(1, "The key is empty").optional() });
/**
 * POST /provider-test: the models an endpoint lists with a key, nothing saved. Without a
 * key, the one `name` already has.
 */
export const TestProvider = z.object({
  name: z.string().optional(),
  type: z.string().default("anthropic"),
  base_url: BaseUrl.default(""),
  key: z.string().default(""),
});

/** GET /commands: what plugins add to the command list (e.g. /journal). */
export interface CommandInfo {
  name: string;
  /** How its argument reads, e.g. "<text>". */
  args?: string;
  description: string;
}

/** POST /sessions/:id/commands, POST /commands: what a plugin command printed, and what it logged. */
export interface CommandResult {
  output?: string;
  logs: string[];
}

/** GET /sessions/:id/usage and /sessions/:id/status: a report, laid out for a terminal. */
export interface Report {
  text: string;
}

/** PUT /model and PUT /effort: the new state, and whether the choice reached config.toml. */
export type Switched = DaemonState & { saved: boolean; error?: string };

// --- Requests --------------------------------------------------------------------------

/** POST /sessions */
export const CreateSession = z.object({
  display: z.enum(DISPLAYS).default("markdown"),
  /** Off the record (DESIGN.md §11, M3): set when it starts, for all of it. */
  offRecord: z.boolean().default(false),
});
/** POST /sessions/:id/prompts: text, images (as POST /images named them), or both. */
export const SendPrompt = z
  .object({
    text: z.string().trim().default(""),
    images: z.array(z.string()).max(20).default([]),
  })
  .refine((p) => p.text || p.images.length, "A message needs text or an image");
/** POST /images answers with the name a prompt gives it; the body is the image itself. */
export interface Uploaded {
  name: string;
}
/** POST /sessions/:id/interrupt: stops the running turn; `clearQueue` also drops the waiting ones. */
export const Interrupt = z.object({ clearQueue: z.boolean().default(false) });
/** POST /permissions/:id */
export const AnswerPermission = z.object({ choice: z.enum(PERMISSION_ANSWERS) });
/**
 * PUT /model: switches now and saves it as the default. The provider may be left out when
 * only one provider has a model by that id.
 */
export const SetModel = z.object({ model: z.string().min(1) });
/** PUT /helper-model: "" for none, side work then running on the main model. */
export const SetHelperModel = z.object({ model: z.string() });
/** PUT /writes-first: whether Ivy writes first. */
export const SetWritesFirst = z.object({ on: z.boolean() });

/** Why /model has nothing to offer: one model, and how to get more. */
export const onlyOneModel = (current: string) =>
  `Only one model is available (${current}). List more under \`models\` in a [providers.*] section, or leave \`models\` out to offer all the endpoint has.`;
/** PUT /effort: likewise. */
export const SetEffort = z.object({ effort: z.string().min(1) });
/** POST /sessions/:id/commands: run a plugin command in a session; POST /commands, outside one. */
export const RunCommand = z.object({
  name: z.string().startsWith("/"),
  args: z.string().default(""),
});

/** A refused request: the status says what kind, the message says why. */
export interface ErrorBody {
  error: string;
}
