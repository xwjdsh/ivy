import Anthropic from "@anthropic-ai/sdk";
import type { RiskLevel } from "@ivy/plugin-api";
import { type Capabilities, downgradable, type OptionalFeature } from "./capabilities.ts";
import { type Config, type ModelRef, type ProviderConfig, resolveModel } from "./config.ts";
import { createLogger, errorMessage } from "./log.ts";
import {
  endpointKey,
  estimateCost,
  type ModelClient,
  type ModelMessage,
  type ModelRequest,
  type RequestExtras,
} from "./model.ts";
import type { PermissionChoice, Permissions } from "./permissions.ts";
import type { PluginHost } from "./plugins.ts";
import {
  namedUrls,
  readsOutside,
  serverToolCall,
  serverToolDefs,
  serverToolResult,
  withoutServerTools,
} from "./server-tools.ts";
import type { Origin, Session } from "./session.ts";
import type { Tracer } from "./trace.ts";
import {
  CONTEXT_SYSTEM_BETA,
  type ContextMode,
  promptText,
  renderMessages,
} from "./turn-context.ts";

type ToolUseBlock = Anthropic.Beta.BetaToolUseBlock;
type MessageParam = Anthropic.Beta.BetaMessageParam;
type ToolResultBlock = Anthropic.Beta.BetaToolResultBlockParam;

export type StopReason =
  | "end_turn"
  | "max_steps"
  | "max_tokens"
  | "refusal"
  | "interrupted"
  | "error"
  | "other";

export type AgentEvent =
  | { type: "text"; delta: string }
  /** Something the user should know about, e.g. a feature the endpoint turned out not to support. */
  | { type: "notice"; text: string }
  /** This turn's plugin context (verbose view; it is otherwise hidden). */
  | { type: "context"; text: string }
  /** What is about to be sent for one model call (verbose view). */
  | { type: "request"; step: number; info: RequestInfo }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      id: string;
      name: string;
      content: string;
      isError: boolean;
      /** The result is outside content (see ToolResult in the plugin API). */
      outside?: boolean;
    }
  | {
      type: "step";
      step: number;
      /** Model that produced the response (differs from the request after a fallback). */
      model: string;
      stopReason: string | null;
      usage: Anthropic.Beta.BetaUsage;
      costUsd: number | null;
      latencyMs: number;
      traceFile?: string;
    };

export interface RequestInfo {
  model: string;
  /** Configured effort, and what is actually sent after per-model adjustment. */
  effort: { configured: string; sent?: string };
  contextMode: ContextMode;
  betas: string[];
  messages: number;
  tools: number;
  maxTokens: number;
  /** Whether this turn carries plugin context. */
  hasContext: boolean;
}

export interface ToolCallRequest {
  name: string;
  input: unknown;
  risk: RiskLevel;
  /** Why the user is asked, e.g. "write tool", "ask rule", "dangerous tool". */
  reason: string;
  /** Whether "for this session" / "always" would have any effect (see Permissions.decide). */
  canRemember: boolean;
}

export interface AgentOptions {
  config: Config;
  /** The API client for a provider (made on first use, then reused). */
  clientFor(provider: ProviderConfig): ModelClient;
  plugins: PluginHost;
  /** The system prompt for a session, frozen once the session starts (see SystemPrompt). */
  systemPrompt(sessionId: string): Promise<string>;
  /** What each model supports on its provider's endpoint. */
  capabilities: Capabilities;
  /** Who may run which tool without asking. */
  permissions: Permissions;
  /** What a session's first turn waits for (a bounded wait), before building its context. */
  beforeFirstTurn?(): Promise<void>;
}

/** What the user sent: text, or text with the images sent along (in the session's folder). */
export type UserPrompt = string | { text: string; images?: string[] };

export interface TurnOptions {
  signal: AbortSignal;
  onEvent(event: AgentEvent): void;
  /** Asked when the permission rules say "ask": whoever runs the turn answers. */
  confirm(call: ToolCallRequest): Promise<PermissionChoice>;
  tracer?: Tracer;
}

export interface TurnResult {
  stopReason: StopReason;
  steps: number;
  costUsd: number;
  error?: string;
}

const MAX_PARSE_RETRIES = 2;
/** The longest a first turn waits for what it starts from: never long, whatever it is. */
const FIRST_TURN_WAIT_MS = 5000;

/** What a turn says before any model is chosen (a new install). */
export const NO_MODEL =
  "Ivy has no model yet: add a provider in Settings and choose a model, or set [agent] model in config.toml.";
const log = createLogger("agent");

/** An off-the-record conversation's line in each turn's context. */
const OFF_RECORD =
  "This conversation is off the record: nothing from it is kept, and it is deleted when it ends. Don't offer to remember anything; if the user asks you to, say you can't in this one.";

export class Agent {
  /** Current model; starts as `agent.model` and can be switched at runtime. None before one is chosen. */
  private current: ModelRef | undefined;

  constructor(private readonly opts: AgentOptions) {
    this.current = opts.config.model;
  }

  /** The current model as "<provider>/<model id>"; "" before one is chosen. */
  get model(): string {
    return this.current?.ref ?? "";
  }

  get modelRef(): ModelRef | undefined {
    return this.current;
  }

  /**
   * Switch models for later turns (not saved), on any configured provider; throws if the
   * reference doesn't resolve or the provider can't be reached (no API key). The prompt
   * cache is per model, so the next call misses it.
   */
  setModel(ref: string): void {
    const next = resolveModel(this.opts.config.providers, ref);
    this.opts.clientFor(next.provider);
    this.current = next;
  }

  /**
   * After the providers changed: the model in use points at its provider as it is now, or at
   * none if it is gone (config.toml edited by hand while Ivy runs; the settings refuse it). No client is made here: a missing key is said by the next turn, as
   * on startup.
   */
  refreshModel(): void {
    if (!this.current) return;
    try {
      this.current = resolveModel(this.opts.config.providers, this.current.ref);
    } catch {
      this.current = undefined;
    }
  }

  /**
   * Run one user turn: call the model, execute tools, repeat until the model ends the turn.
   *
   * History invariant: an assistant message containing tool_use blocks is only appended
   * together with its tool_result message, so the session is always a valid request,
   * even after an interruption.
   */
  async runTurn(session: Session, prompt: UserPrompt, turn: TurnOptions): Promise<TurnResult> {
    const { config } = this.opts;
    // One model for the whole turn; a switch applies from the next one. None yet: nothing
    // is written, so the message isn't left without a reply.
    const target = this.current;
    if (!target) throw new Error(NO_MODEL);
    // No API key throws here, before the message is written.
    const client = this.opts.clientFor(target.provider);
    // Whether a compatible endpoint passes the model's search on is found out in the
    // background (DESIGN.md §5.2, source 3); later turns use what it finds.
    if (this.opts.plugins.serverTools().has("web_search")) {
      void this.opts.capabilities.probeWebSearch(target, client);
    }
    const { text: userText, images = [] } = typeof prompt === "string" ? { text: prompt } : prompt;
    const system = await this.opts.systemPrompt(session.id);
    const ready = session.messages.length === 0 && this.opts.beforeFirstTurn?.();
    // Never longer than the cap, nor past an interrupt.
    if (ready) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          turn.signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, FIRST_TURN_WAIT_MS);
        turn.signal.addEventListener("abort", done);
        ready.then(done, done);
      });
    }
    // Off the record, said on every turn, so she says so herself when it matters and offers
    // to keep nothing (DESIGN.md §11, M3).
    const context = await this.opts.plugins.turnContext(
      { sessionId: session.id, userText, now: new Date() },
      session.offRecord ? [{ id: "conversation", text: OFF_RECORD }] : [],
    );
    session.appendPrompt(userText, context, images);
    const turnNumber = session.messages.filter((m) => promptText(m) !== null).length;
    if (context) turn.onEvent({ type: "context", text: context });

    let costUsd = 0;
    let parseRetries = 0;
    const downgraded = new Set<OptionalFeature>();

    const origin: Origin = { endpoint: endpointKey(target.provider.base_url), model: target.id };
    for (let step = 1; step <= config.agent.max_steps; step++) {
      const { request, extras } = this.buildRequest(target, session, system);
      turn.onEvent({ type: "request", step, info: this.describe(request, context !== "") });
      const startedAt = new Date();
      let message: ModelMessage;
      /** Whether this step's text reached the user before it failed. */
      let shown = false;

      try {
        message = await client.stream(
          request,
          {
            onText: (delta) => {
              shown = true;
              turn.onEvent({ type: "text", delta });
            },
            // The vendor's tools run within the reply: shown as each block completes.
            onBlock: (block) => {
              const call = serverToolCall(block);
              if (call) turn.onEvent({ type: "tool_call", ...call });
              const result = serverToolResult(block);
              if (result) turn.onEvent({ type: "tool_result", ...result });
            },
          },
          turn.signal,
          extras,
        );
      } catch (err) {
        const latencyMs = Date.now() - startedAt.getTime();
        turn.tracer?.record({
          request,
          error: errorMessage(err),
          startedAt: startedAt.toISOString(),
          latencyMs,
        });
        if (turn.signal.aborted) return { stopReason: "interrupted", steps: step, costUsd };
        // The endpoint rejected an optional feature (compatibility first): turn it off for
        // this model, remember that, and resend. Nothing was appended, so this is safe.
        const feature = downgradable(err, request, extras);
        // Once per feature a turn: one whose removal didn't take would loop, paying each time.
        if (feature && !downgraded.has(feature)) {
          downgraded.add(feature);
          this.opts.capabilities.markUnsupported(target, feature);
          turn.onEvent({
            type: "notice",
            text: `${target.ref} doesn't support ${FEATURE_NAMES[feature]} here; continuing without it.`,
          });
          step--;
          continue;
        }
        // With eager input streaming, an unparseable tool input rejects the stream.
        // Nothing was appended, so re-issuing the same request is safe.
        if (isToolJsonParseError(err) && parseRetries++ < MAX_PARSE_RETRIES) {
          // The error quotes the input; the log outlives an off-the-record conversation.
          log.warn(
            "tool input JSON could not be parsed, retrying",
            session.offRecord ? undefined : errorMessage(err),
          );
          // What was already shown comes again: say why, rather than leave it unexplained.
          if (shown) {
            turn.onEvent({
              type: "notice",
              text: "The reply broke off while writing a tool call; it is written again below.",
            });
          }
          step--;
          continue;
        }
        return { stopReason: "error", steps: step, costUsd, error: errorMessage(err) };
      }
      parseRetries = 0;

      const latencyMs = Date.now() - startedAt.getTime();
      const traceFile = turn.tracer?.record({
        request,
        response: message,
        startedAt: startedAt.toISOString(),
        latencyMs,
      });
      // Server-side refusal fallback: the model declined and another one answered.
      for (const block of message.content) {
        if (block.type === "fallback") {
          turn.onEvent({
            type: "notice",
            text: `${block.from.model} declined this request; ${block.to.model} answered instead.`,
          });
        }
      }
      const stepCost = estimateCost(message.model, message.usage);
      costUsd += stepCost ?? 0;
      session.recordUsage(message.usage, stepCost ?? 0);
      turn.onEvent({
        type: "step",
        step,
        model: message.model,
        stopReason: message.stop_reason,
        usage: message.usage,
        costUsd: stepCost,
        latencyMs,
        traceFile,
      });

      // A refusal may cut content off mid-block; don't keep it in history.
      if (message.stop_reason === "refusal") return { stopReason: "refusal", steps: step, costUsd };

      // The vendor searched within this reply, so what follows in it was written after
      // reading the results, the reply's own tool calls included (DESIGN.md §8.1).
      const read = readsOutside(message.content);
      if (read) {
        const ids = message.content.flatMap((b) => {
          const result = serverToolResult(b);
          return result?.outside ? [result.id] : [];
        });
        session.markOutside(read, ids);
      }

      if (message.stop_reason === "pause_turn") {
        session.appendFrom(origin, { role: "assistant", content: message.content });
        continue;
      }

      const toolUses = message.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0) {
        if (message.content.length > 0) {
          session.appendFrom(origin, { role: "assistant", content: message.content });
        }
        return { stopReason: mapStopReason(message.stop_reason), steps: step, costUsd };
      }

      // A tool input cut off at max_tokens can still look valid; never run it.
      if (message.stop_reason === "max_tokens") {
        return { stopReason: "max_tokens", steps: step, costUsd };
      }

      const { results, outside } = await this.runTools(session, message, turn, turnNumber);
      session.appendFrom(
        origin,
        { role: "assistant", content: message.content },
        { role: "user", content: results },
      );
      // After the results, so what Ivy said before reading them isn't counted as outside.
      if (outside) session.markOutside(outside.tool, outside.ids);
      if (turn.signal.aborted) return { stopReason: "interrupted", steps: step, costUsd };
    }

    return { stopReason: "max_steps", steps: config.agent.max_steps, costUsd };
  }

  private buildRequest(
    target: ModelRef,
    session: Session,
    systemPrompt: string,
  ): { request: ModelRequest; extras: RequestExtras } {
    const { config, plugins } = this.opts;
    const caps = this.opts.capabilities.for(target);
    // A deny rule turns a vendor tool off too: it never passes through the permission gate.
    const serverTools = serverToolDefs(
      plugins.serverTools(),
      caps,
      // Named bare, or under its plugin's prefix: `deny = ["web__*"]` turns the web plugin off.
      (name) =>
        [name, ...plugins.serverToolOwners(name).map((id) => `${id}__${name}`)].every(
          (n) => this.opts.permissions.decide(n, "read", session.id).decision !== "deny",
        ),
    );
    const request: ModelRequest = {
      model: target.id,
      max_tokens: Math.min(
        config.generation.max_tokens,
        caps.maxTokens ?? Number.POSITIVE_INFINITY,
      ),
      tools: [
        ...plugins.apiTools(),
        // Last: a change in the vendor's tools (a model with or without search) costs one cache
        // miss; the plugins' tools come first, unchanged.
        ...serverTools,
      ],
      // System messages for context where the model and endpoint support them, else text blocks.
      messages: renderMessages(
        session.messages.map((m) => {
          const seen = forModel(m, session.originOf(m), target, caps.images);
          // Without the tool, an endpoint may refuse its blocks.
          return serverTools.length ? seen : withoutServerTools(seen);
        }),
        (m) => session.contextOf(m),
        caps.systemMessages ? "system" : "block",
      ),
      // Automatic caching: caches the longest stable prefix, which moves forward each turn.
      cache_control: { type: "ephemeral" },
    };
    if (caps.effort) request.output_config = { effort: caps.effort };
    // The API rejects empty text blocks, so an empty prompt means no system field.
    if (systemPrompt) request.system = [{ type: "text", text: systemPrompt }];
    const betas: string[] = [];
    if (caps.fallbacks) {
      betas.push("server-side-fallback-2026-07-01");
      request.fallbacks = "default";
    }
    if (request.messages.some((m) => m.role === "system")) betas.push(CONTEXT_SYSTEM_BETA);
    if (betas.length > 0) request.betas = betas;
    const extras: RequestExtras = {
      ...(caps.streamUsage && { streamUsage: true }),
      ...(caps.cacheKey && { cacheKey: session.id }),
    };
    return { request, extras };
  }

  private describe(request: ModelRequest, hasContext: boolean): RequestInfo {
    return {
      model: request.model,
      effort: {
        configured: this.opts.capabilities.effort,
        sent: request.output_config?.effort ?? undefined,
      },
      contextMode: request.betas?.includes(CONTEXT_SYSTEM_BETA) ? "system" : "block",
      betas: request.betas ?? [],
      messages: request.messages.length,
      tools: request.tools?.length ?? 0,
      maxTokens: request.max_tokens,
      hasContext,
    };
  }

  /**
   * Ask permission sequentially (prompts can't overlap), then run approved tools in parallel.
   * `outside`: the first tool whose result was outside content, if any. Calls in one batch
   * see the session as it was before it: their input was written before any result.
   */
  private async runTools(
    session: Session,
    reply: ModelMessage,
    turn: TurnOptions,
    turnNumber: number,
  ): Promise<{ results: ToolResultBlock[]; outside?: { tool: string; ids: string[] } }> {
    const { plugins, permissions } = this.opts;
    const { id: sessionId, tainted } = session;
    const toolUses = reply.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
    // What the user wrote and searches returned, this reply's own searches included; read
    // only by a tool that asks about addresses.
    let urls: Set<string> | undefined;
    const call = {
      tainted,
      get urls() {
        urls ??= namedUrls([...session.messages, { role: "assistant", content: reply.content }]);
        return urls;
      },
    };
    const toolLog = createLogger("tool");

    type Verdict =
      | "run"
      | "unknown tool"
      | "off the record"
      | "denied by rule"
      | "denied by user"
      | "unanswered"
      | "interrupted";
    const verdicts: Verdict[] = [];
    for (const use of toolUses) {
      turn.onEvent({ type: "tool_call", id: use.id, name: use.name, input: use.input });
      const risk = plugins.riskOf(use.name);
      if (turn.signal.aborted) {
        verdicts.push("interrupted");
        continue;
      }
      if (risk === undefined) {
        verdicts.push("unknown tool"); // a name the model made up; nothing to ask about
        continue;
      }
      // Nothing from an off-the-record conversation is kept, whatever the rules allow.
      if (session.offRecord && plugins.writesOwnRecords(use.name)) {
        verdicts.push("off the record");
        continue;
      }
      const ruled = permissions.decide(use.name, risk, sessionId);
      // A tool may need the user's OK for this call whatever allows it; a deny rule still wins.
      const askFirst = ruled.decision !== "deny" && plugins.askFirst(use.name, use.input, call);
      // A turn that read outside content asks before anything goes out, whatever allows it:
      // an injected instruction must not reach the world unseen, if a tool forgot to ask.
      const outward = ruled.decision === "allow" && tainted && risk === "external";
      const reason = askFirst || (outward ? "this turn read outside content" : undefined);
      const decided = reason ? { decision: "ask" as const, reason, canRemember: false } : ruled;
      if (decided.decision !== "ask") {
        verdicts.push(decided.decision === "allow" ? "run" : "denied by rule");
        continue;
      }
      const choice = await turn.confirm({
        name: use.name,
        input: use.input,
        risk,
        reason: decided.reason,
        canRemember: decided.canRemember,
      });
      const allowed = permissions.remember(use.name, choice, decided, sessionId);
      verdicts.push(allowed ? "run" : choice === "unanswered" ? "unanswered" : "denied by user");
    }

    const messages: Record<Exclude<Verdict, "run">, (name: string) => string> = {
      "unknown tool": (name) => `Unknown tool: ${name}`,
      "off the record": () =>
        "This conversation is off the record: nothing from it is kept, so this didn't run.",
      "denied by rule": () => "This tool call is blocked by a permission rule.",
      "denied by user": () => "The user denied this tool call.",
      unanswered: () =>
        "No one answered the permission prompt in time, so this tool call didn't run. The user may not be around.",
      interrupted: () => "Interrupted by the user before this tool ran.",
    };
    let outside: { tool: string; ids: string[] } | undefined;
    const results = await Promise.all(
      toolUses.map(async (use, i): Promise<ToolResultBlock> => {
        const verdict = turn.signal.aborted ? "interrupted" : (verdicts[i] ?? "interrupted");
        const outcome =
          verdict === "run"
            ? await plugins.call(use.name, use.input, {
                signal: turn.signal,
                log: toolLog,
                sessionId,
                turn: turnNumber,
                tainted,
              })
            : { content: messages[verdict](use.name), isError: true };
        if (outcome.outside) {
          outside ??= { tool: use.name, ids: [] };
          outside.ids.push(use.id);
        }
        turn.onEvent({
          type: "tool_result",
          id: use.id,
          name: use.name,
          content: outcome.content,
          isError: outcome.isError,
          ...(outcome.outside && { outside: true }),
        });
        return {
          type: "tool_result",
          tool_use_id: use.id,
          content: outcome.content,
          is_error: outcome.isError || undefined,
        };
      }),
    );
    return { results, outside };
  }
}

const FEATURE_NAMES: Record<OptionalFeature, string> = {
  effort: "the effort setting",
  fallbacks: "server-side refusal fallback",
  systemMessages: "mid-conversation system messages",
  streamUsage: "usage in the stream",
  cacheKey: "a prompt cache key",
  images: "images (each is left out, and kept in the conversation)",
  webSearch: "web search",
};

/**
 * A message as `target` may see it: a reply's thinking goes back only to the model that wrote
 * it, at the endpoint it came from (DESIGN.md §5.2.1); elsewhere it is dropped, as another
 * backend may reject what it can't verify. Replies from before origins were recorded keep it.
 * A prompt's images go only to a model that takes them (`images`).
 */
function forModel(
  m: MessageParam,
  origin: Origin | undefined,
  target: ModelRef,
  images: boolean,
): MessageParam {
  if (m.role === "user") return images ? m : withoutImages(m);
  if (m.role !== "assistant" || !origin || typeof m.content === "string") return m;
  if (origin.endpoint === endpointKey(target.provider.base_url) && origin.model === target.id) {
    return m;
  }
  const content = m.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
  if (content.length === m.content.length) return m;
  // A reply of thinking alone keeps its place, the turns staying in order.
  return { ...m, content: content.length ? content : [{ type: "text", text: "…" }] };
}

const isImage = (b: { type: string }) => b.type === "image";

/** A prompt for a model that takes no images: a line in place of each (the session keeps them). */
function withoutImages(m: MessageParam): MessageParam {
  if (typeof m.content === "string" || !m.content.some(isImage)) return m;
  const content = m.content.map((b) =>
    isImage(b)
      ? { type: "text" as const, text: "[An image was left out: this model takes none]" }
      : b,
  );
  return { ...m, content };
}

/**
 * The SDK reports unparseable streamed tool JSON as a plain AnthropicError (no dedicated
 * subclass), so the message prefix is the only way to tell it apart from e.g. auth errors.
 */
function isToolJsonParseError(err: unknown): boolean {
  return (
    err instanceof Anthropic.AnthropicError &&
    !(err instanceof Anthropic.APIError) &&
    err.message.startsWith("Unable to parse tool parameter JSON")
  );
}

function mapStopReason(reason: string | null): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    default:
      return "other";
  }
}
