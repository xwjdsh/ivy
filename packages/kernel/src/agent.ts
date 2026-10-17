import Anthropic from "@anthropic-ai/sdk";
import type { RiskLevel } from "@ivy/plugin-api";
import { type Capabilities, type OptionalFeature, rejectedFeature } from "./capabilities.ts";
import type { Config } from "./config.ts";
import { createLogger } from "./log.ts";
import { estimateCost, type ModelClient, type ModelMessage, type ModelRequest } from "./model.ts";
import type { PermissionChoice, Permissions } from "./permissions.ts";
import { errorMessage, type PluginHost } from "./plugins.ts";
import type { Session } from "./session.ts";
import type { Tracer } from "./trace.ts";
import { CONTEXT_SYSTEM_BETA, type ContextMode, renderMessages } from "./turn-context.ts";

type ToolUseBlock = Anthropic.Beta.BetaToolUseBlock;
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
  | { type: "tool_result"; id: string; name: string; content: string; isError: boolean }
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
  model: ModelClient;
  plugins: PluginHost;
  systemPrompt: string;
  /** What the current model supports on the active endpoint. */
  capabilities: Capabilities;
  /** Who may run which tool without asking. */
  permissions: Permissions;
  /** Asked when the permission rules say "ask". */
  confirm(call: ToolCallRequest): Promise<PermissionChoice>;
}

export interface TurnOptions {
  signal: AbortSignal;
  onEvent(event: AgentEvent): void;
  tracer?: Tracer;
}

export interface TurnResult {
  stopReason: StopReason;
  steps: number;
  costUsd: number;
  error?: string;
}

const MAX_PARSE_RETRIES = 2;
const log = createLogger("agent");

export class Agent {
  /** Current model; starts as the provider's default_model and can be switched at runtime. */
  private modelName: string;

  constructor(private readonly opts: AgentOptions) {
    this.modelName = opts.config.activeProvider.default_model;
  }

  get model(): string {
    return this.modelName;
  }

  /** Switch models for later turns (not saved). The prompt cache is per model, so the next call misses it. */
  setModel(name: string): void {
    this.modelName = name;
  }

  /**
   * Run one user turn: call the model, execute tools, repeat until the model ends the turn.
   *
   * History invariant: an assistant message containing tool_use blocks is only appended
   * together with its tool_result message, so the session is always a valid request,
   * even after an interruption.
   */
  async runTurn(session: Session, userText: string, turn: TurnOptions): Promise<TurnResult> {
    const { config } = this.opts;
    const context = await this.opts.plugins.turnContext({
      sessionId: session.id,
      userText,
      now: new Date(),
    });
    session.appendPrompt(userText, context);
    if (context) turn.onEvent({ type: "context", text: context });

    let costUsd = 0;
    let parseRetries = 0;

    for (let step = 1; step <= config.agent.max_steps; step++) {
      const request = this.buildRequest(session);
      turn.onEvent({ type: "request", step, info: this.describe(request, context !== "") });
      const startedAt = new Date();
      let message: ModelMessage;

      try {
        message = await this.opts.model.stream(
          request,
          { onText: (delta) => turn.onEvent({ type: "text", delta }) },
          turn.signal,
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
        const feature = downgradable(err, request);
        if (feature) {
          this.opts.capabilities.markUnsupported(this.modelName, feature);
          turn.onEvent({
            type: "notice",
            text: `${this.modelName} doesn't support ${FEATURE_NAMES[feature]} here; continuing without it.`,
          });
          step--;
          continue;
        }
        // With eager input streaming, an unparseable tool input rejects the stream.
        // Nothing was appended, so re-issuing the same request is safe.
        if (isToolJsonParseError(err) && parseRetries++ < MAX_PARSE_RETRIES) {
          log.warn("tool input JSON could not be parsed, retrying", errorMessage(err));
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

      if (message.stop_reason === "pause_turn") {
        session.append({ role: "assistant", content: message.content });
        continue;
      }

      const toolUses = message.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0) {
        if (message.content.length > 0) {
          session.append({ role: "assistant", content: message.content });
        }
        return { stopReason: mapStopReason(message.stop_reason), steps: step, costUsd };
      }

      // A tool input cut off at max_tokens can still look valid; never run it.
      if (message.stop_reason === "max_tokens") {
        return { stopReason: "max_tokens", steps: step, costUsd };
      }

      const results = await this.runTools(toolUses, turn);
      session.append(
        { role: "assistant", content: message.content },
        { role: "user", content: results },
      );
      if (turn.signal.aborted) return { stopReason: "interrupted", steps: step, costUsd };
    }

    return { stopReason: "max_steps", steps: config.agent.max_steps, costUsd };
  }

  private buildRequest(session: Session): ModelRequest {
    const { config, plugins, systemPrompt } = this.opts;
    const caps = this.opts.capabilities.for(this.modelName);
    const request: ModelRequest = {
      model: this.modelName,
      max_tokens: Math.min(
        config.generation.max_tokens,
        caps.maxTokens ?? Number.POSITIVE_INFINITY,
      ),
      tools: plugins.apiTools(),
      messages: renderMessages(session.messages, (m) => session.contextOf(m), this.contextMode()),
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
    return request;
  }

  private describe(request: ModelRequest, hasContext: boolean): RequestInfo {
    return {
      model: request.model,
      effort: {
        configured: this.opts.capabilities.effort,
        sent: request.output_config?.effort ?? undefined,
      },
      contextMode: this.contextMode(),
      betas: request.betas ?? [],
      messages: request.messages.length,
      tools: request.tools?.length ?? 0,
      maxTokens: request.max_tokens,
      hasContext,
    };
  }

  /** System messages where the model and endpoint support them; text blocks elsewhere. */
  contextMode(): ContextMode {
    return this.opts.capabilities.for(this.modelName).systemMessages ? "system" : "block";
  }

  /** Ask permission sequentially (prompts can't overlap), then run approved tools in parallel. */
  private async runTools(toolUses: ToolUseBlock[], turn: TurnOptions): Promise<ToolResultBlock[]> {
    const { plugins, confirm, permissions } = this.opts;
    const toolLog = createLogger("tool");

    type Verdict = "run" | "unknown tool" | "denied by rule" | "denied by user" | "interrupted";
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
      const decided = permissions.decide(use.name, risk);
      if (decided.decision !== "ask") {
        verdicts.push(decided.decision === "allow" ? "run" : "denied by rule");
        continue;
      }
      const choice = await confirm({
        name: use.name,
        input: use.input,
        risk,
        reason: decided.reason,
        canRemember: decided.canRemember,
      });
      verdicts.push(permissions.remember(use.name, choice, decided) ? "run" : "denied by user");
    }

    const messages: Record<Exclude<Verdict, "run">, (name: string) => string> = {
      "unknown tool": (name) => `Unknown tool: ${name}`,
      "denied by rule": () => "This tool call is blocked by a permission rule.",
      "denied by user": () => "The user denied this tool call.",
      interrupted: () => "Interrupted by the user before this tool ran.",
    };
    return Promise.all(
      toolUses.map(async (use, i): Promise<ToolResultBlock> => {
        const verdict = turn.signal.aborted ? "interrupted" : (verdicts[i] ?? "interrupted");
        const outcome =
          verdict === "run"
            ? await plugins.call(use.name, use.input, { signal: turn.signal, log: toolLog })
            : { content: messages[verdict](use.name), isError: true };
        turn.onEvent({ type: "tool_result", id: use.id, name: use.name, ...outcome });
        return {
          type: "tool_result",
          tool_use_id: use.id,
          content: outcome.content,
          is_error: outcome.isError || undefined,
        };
      }),
    );
  }
}

const FEATURE_NAMES: Record<OptionalFeature, string> = {
  effort: "the effort setting",
  fallbacks: "server-side refusal fallback",
  systemMessages: "mid-conversation system messages",
};

/** A 400 about an optional feature this request actually used. */
function downgradable(err: unknown, request: ModelRequest): OptionalFeature | null {
  if (!(err instanceof Anthropic.BadRequestError)) return null;
  const feature = rejectedFeature(err.message);
  const used =
    (feature === "effort" && request.output_config?.effort !== undefined) ||
    (feature === "fallbacks" && request.fallbacks !== undefined) ||
    (feature === "systemMessages" && request.messages.some((m) => m.role === "system"));
  return used ? feature : null;
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
