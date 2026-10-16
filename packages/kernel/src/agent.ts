import Anthropic from "@anthropic-ai/sdk";
import type { RiskLevel } from "@ivy/plugin-api";
import type { Config } from "./config.ts";
import { createLogger } from "./log.ts";
import {
  estimateCost,
  type ModelClient,
  type ModelMessage,
  type ModelRequest,
  modelCapabilities,
} from "./model.ts";
import { errorMessage, type PluginHost } from "./plugins.ts";
import type { Session } from "./session.ts";
import type { Tracer } from "./trace.ts";

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
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; content: string; isError: boolean }
  | {
      type: "step";
      step: number;
      stopReason: string | null;
      usage: Anthropic.Beta.BetaUsage;
      costUsd: number | null;
      latencyMs: number;
      traceFile?: string;
    };

export interface ToolCallRequest {
  name: string;
  input: unknown;
  risk: RiskLevel;
}

export interface AgentOptions {
  config: Config;
  model: ModelClient;
  plugins: PluginHost;
  systemPrompt: string;
  /** Asked before any tool whose risk is not "read". Resolve true to allow. */
  confirm(call: ToolCallRequest): Promise<boolean>;
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
    session.append({ role: "user", content: userText });

    let costUsd = 0;
    let parseRetries = 0;

    for (let step = 1; step <= config.agent.max_steps; step++) {
      const request = this.buildRequest(session);
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
      const stepCost = estimateCost(message.model, message.usage);
      costUsd += stepCost ?? 0;
      session.recordUsage(message.usage, stepCost ?? 0);
      turn.onEvent({
        type: "step",
        step,
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
    const caps = modelCapabilities(this.modelName);
    const request: ModelRequest = {
      model: this.modelName,
      max_tokens: config.generation.max_tokens,
      tools: plugins.apiTools(),
      messages: [...session.messages],
      // Automatic caching: caches the longest stable prefix, which moves forward each turn.
      cache_control: { type: "ephemeral" },
    };
    if (caps.effort) request.output_config = { effort: config.generation.effort };
    // The API rejects empty text blocks, so an empty prompt means no system field.
    if (systemPrompt) request.system = [{ type: "text", text: systemPrompt }];
    if (config.activeProvider.refusal_fallback && caps.fallbacks) {
      request.betas = ["server-side-fallback-2026-07-01"];
      request.fallbacks = "default";
    }
    return request;
  }

  /** Ask permission sequentially (prompts can't overlap), then run approved tools in parallel. */
  private async runTools(toolUses: ToolUseBlock[], turn: TurnOptions): Promise<ToolResultBlock[]> {
    const { plugins, confirm } = this.opts;
    const toolLog = createLogger("tool");

    const approved: boolean[] = [];
    for (const use of toolUses) {
      turn.onEvent({ type: "tool_call", id: use.id, name: use.name, input: use.input });
      const risk = plugins.riskOf(use.name);
      const allowed =
        !turn.signal.aborted &&
        (risk === undefined ||
          risk === "read" ||
          (await confirm({ name: use.name, input: use.input, risk })));
      approved.push(allowed);
    }

    return Promise.all(
      toolUses.map(async (use, i): Promise<ToolResultBlock> => {
        const outcome = turn.signal.aborted
          ? { content: "Interrupted by the user before this tool ran.", isError: true }
          : approved[i]
            ? await plugins.call(use.name, use.input, { signal: turn.signal, log: toolLog })
            : { content: "The user denied this tool call.", isError: true };
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
