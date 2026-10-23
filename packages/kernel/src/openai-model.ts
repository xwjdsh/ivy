// OpenAI's Chat Completions, for `type = "openai"` (DESIGN.md §5.2.1). Ivy's own format is the
// Messages API's; this client translates at its edge, both ways, so the agent loop, sessions
// and traces never see Chat Completions. On OpenAI's own API it uses what is OpenAI's alone
// (max_completion_tokens, the developer role); elsewhere the plainest request, as many
// endpoints copy the protocol loosely. Errors come out as the Anthropic SDK's, so the loop
// handles both protocols' 400s alike.

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import {
  isOfficialApi,
  type ModelClient,
  type ModelMessage,
  type ModelRequest,
  type RequestExtras,
  type StreamHandlers,
} from "./model.ts";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type Block = Anthropic.Beta.BetaContentBlock;

export class OpenAIChatClient implements ModelClient {
  private readonly client: OpenAI;
  private readonly official: boolean;

  /**
   * Credentials and endpoint come only from Ivy's config: passing both stops the SDK from
   * picking up OPENAI_API_KEY or OPENAI_BASE_URL.
   */
  constructor(opts: { apiKey: string; baseURL: string }) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL, fetch: keepErrorText });
    this.official = isOfficialApi("openai", opts.baseURL);
  }

  async stream(
    request: ModelRequest,
    handlers: StreamHandlers,
    signal: AbortSignal,
    extras: RequestExtras = {},
  ): Promise<ModelMessage> {
    const params = toChatRequest(request, extras, this.official);
    let stream: AsyncIterable<ChatCompletionChunk>;
    try {
      stream = await this.client.chat.completions.create(params, { signal });
    } catch (err) {
      throw asAnthropicError(err);
    }
    const reply = new ReplyBuilder(request.model, handlers);
    try {
      for await (const chunk of stream) reply.add(chunk);
    } catch (err) {
      throw asAnthropicError(err);
    }
    return reply.finish();
  }

  async listModels(): Promise<Anthropic.Models.ModelInfo[]> {
    const models: Anthropic.Models.ModelInfo[] = [];
    try {
      for await (const m of this.client.models.list()) {
        models.push({
          id: m.id,
          display_name: m.id,
          created_at: new Date((m.created ?? 0) * 1000).toISOString(),
          type: "model",
        } as Anthropic.Models.ModelInfo);
      }
    } catch (err) {
      throw asAnthropicError(err);
    }
    return models;
  }
}

/**
 * The SDK reads an error from `{"error": {...}}` alone and loses any other body (FastAPI's
 * `{"detail": ...}`, plain text), which the loop needs to tell what an endpoint refused: such
 * a body is passed on as `{"error": {"message": <the body>}}`.
 */
export const keepErrorText: typeof fetch = Object.assign(
  async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const res = await fetch(input, init);
    if (res.ok) return res;
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {}
    const ok = json && typeof json === "object" && "error" in json;
    const body = ok ? text : JSON.stringify({ error: { message: text || res.statusText } });
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  },
  { preconnect: fetch.preconnect },
);

/** Ivy's request (the Messages API's) as Chat Completions. */
export function toChatRequest(
  request: ModelRequest,
  extras: RequestExtras,
  official: boolean,
): ChatCompletionCreateParamsStreaming {
  const messages: ChatCompletionMessageParam[] = [];
  const system = textOf(request.system);
  // The developer role is OpenAI's: elsewhere it could be taken for a user's message.
  if (system) messages.push({ role: official ? "developer" : "system", content: system });

  // A model's reasoning goes back only within its own turn: after the last thing the user
  // typed (DESIGN.md §5.2.1). Earlier reasoning is the endpoint's to drop, and some reject it.
  const turnStart = lastPromptIndex(request.messages);
  request.messages.forEach((m, i) => {
    messages.push(...toChatMessages(m, i > turnStart));
  });

  const params: ChatCompletionCreateParamsStreaming = {
    model: request.model,
    messages,
    stream: true,
  };
  // An endpoint that ignores max_completion_tokens would drop the cap: OpenAI's own only.
  if (official) params.max_completion_tokens = request.max_tokens;
  else params.max_tokens = request.max_tokens;
  const tools = (request.tools ?? []).flatMap(toChatTool);
  if (tools.length) params.tools = tools;
  const effort = request.output_config?.effort;
  if (effort) params.reasoning_effort = effort;
  if (extras.streamUsage) params.stream_options = { include_usage: true };
  if (extras.cacheKey) params.prompt_cache_key = extras.cacheKey;
  return params;
}

function toChatTool(tool: NonNullable<ModelRequest["tools"]>[number]): ChatCompletionTool[] {
  if (!("input_schema" in tool)) return []; // server tools are Anthropic's
  return [
    {
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description && { description: tool.description }),
        parameters: tool.input_schema as Record<string, unknown>,
      },
    },
  ];
}

/** One of Ivy's messages as Chat Completions messages: tool results become messages of their own. */
function toChatMessages(m: MessageParam, inTurn: boolean): ChatCompletionMessageParam[] {
  if (m.role === "system") return [{ role: "system", content: textOf(m.content) }];
  if (typeof m.content === "string") {
    return [m.role === "user" ? { role: "user", content: m.content } : assistant(m.content)];
  }
  if (m.role === "assistant") {
    const text = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    const reasoning = inTurn
      ? m.content.flatMap((b) => (b.type === "thinking" ? [b.thinking] : [])).join("")
      : "";
    const calls: ChatCompletionMessageToolCall[] = m.content.flatMap((b) =>
      b.type === "tool_use"
        ? [
            {
              id: b.id,
              type: "function" as const,
              function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
            },
          ]
        : [],
    );
    const out = assistant(text, calls);
    // DeepSeek's field, which most endpoints that send reasoning use; it carries a tool
    // loop's reasoning on, where an endpoint wants it.
    if (reasoning) (out as { reasoning_content?: string }).reasoning_content = reasoning;
    return [out];
  }
  // A user message: tool results first, each a message of its own, as they must follow the
  // assistant's calls directly; then what else it holds.
  const out: ChatCompletionMessageParam[] = [];
  const rest: OpenAI.Chat.ChatCompletionContentPart[] = [];
  const images: OpenAI.Chat.ChatCompletionContentPart[] = [];
  for (const b of m.content) {
    if (b.type === "tool_result") {
      const content = Array.isArray(b.content) ? b.content : [];
      const text =
        typeof b.content === "string"
          ? b.content
          : content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
      out.push({ role: "tool", tool_call_id: b.tool_use_id, content: text });
      // A tool result takes only text: its images follow in a user message.
      for (const c of content) if (c.type === "image") images.push(...imagePart(c));
    } else if (b.type === "text") {
      rest.push({ type: "text", text: b.text });
    } else if (b.type === "image") {
      rest.push(...imagePart(b));
    }
  }
  const after = [...images, ...rest];
  if (after.length) out.push({ role: "user", content: after });
  return out;
}

function assistant(
  text: string,
  calls: ChatCompletionMessageToolCall[] = [],
): ChatCompletionMessageParam {
  return {
    role: "assistant",
    content: text || (calls.length ? null : ""),
    ...(calls.length && { tool_calls: calls }),
  };
}

function imagePart(
  b: Anthropic.Beta.BetaImageBlockParam,
): OpenAI.Chat.ChatCompletionContentPartImage[] {
  const src = b.source;
  if (src.type === "base64") {
    return [{ type: "image_url", image_url: { url: `data:${src.media_type};base64,${src.data}` } }];
  }
  if (src.type === "url") return [{ type: "image_url", image_url: { url: src.url } }];
  return [];
}

function textOf(content: ModelRequest["system"] | MessageParam["content"]): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n\n");
}

/** The last message with something the user typed (not only tool results), or -1. */
function lastPromptIndex(messages: MessageParam[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string" || m.content.some((b) => b.type !== "tool_result")) return i;
  }
  return -1;
}

/** Chunks of a streamed reply, put together as a reply in Ivy's format. */
export class ReplyBuilder {
  private text = "";
  private reasoning = "";
  private readonly calls = new Map<number, { id: string; name: string; args: string }>();
  private finishReason: string | null = null;
  private usage: OpenAI.CompletionUsage | undefined;
  private id = "";
  private model: string;

  constructor(
    requested: string,
    private readonly handlers: StreamHandlers,
  ) {
    this.model = requested;
  }

  add(chunk: ChatCompletionChunk): void {
    if (chunk.id) this.id = chunk.id;
    if (chunk.model) this.model = chunk.model;
    if (chunk.usage) this.usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    const delta = choice.delta as ChatCompletionChunk.Choice.Delta & {
      reasoning_content?: string | null;
      reasoning?: string | null;
    };
    // Endpoints name the reasoning as they like; these are the ones in use.
    const thought = delta.reasoning_content ?? delta.reasoning;
    if (thought) this.reasoning += thought;
    if (delta.content) {
      this.text += delta.content;
      this.handlers.onText?.(delta.content);
    }
    for (const call of delta.tool_calls ?? []) {
      const at = this.calls.get(call.index) ?? { id: "", name: "", args: "" };
      if (call.id) at.id = call.id;
      if (call.function?.name) at.name += call.function.name;
      if (call.function?.arguments) at.args += call.function.arguments;
      this.calls.set(call.index, at);
    }
  }

  finish(): ModelMessage {
    const content: Block[] = [];
    // Kept as thinking, to go back to this model only (a signature no API would accept).
    if (this.reasoning) content.push({ type: "thinking", thinking: this.reasoning, signature: "" });
    if (this.text) content.push({ type: "text", text: this.text, citations: null });
    for (const [index, call] of [...this.calls.entries()].sort(([a], [b]) => a - b)) {
      let input: unknown = {};
      if (call.args.trim()) {
        try {
          input = JSON.parse(call.args);
        } catch {
          // Cut off by the length limit: the reply ends at max_tokens, whose calls never run;
          // asking again would only be cut off again.
          if (this.finishReason === "length") continue;
          // As the Anthropic SDK words it, so the loop retries as it does there.
          throw new Anthropic.AnthropicError(
            `Unable to parse tool parameter JSON from model. Please retry your request or adjust your prompt. Error: ${call.name}: ${call.args.slice(0, 200)}`,
          );
        }
      }
      content.push({
        type: "tool_use",
        id: call.id || `call_${index}`,
        name: call.name,
        input,
      } as Block);
    }
    const hasCalls = this.calls.size > 0;
    return {
      id: this.id || "chatcmpl",
      type: "message",
      role: "assistant",
      model: this.model,
      content,
      stop_reason: stopReason(this.finishReason, hasCalls),
      stop_sequence: null,
      usage: usageOf(this.usage),
    } as unknown as ModelMessage;
  }
}

function stopReason(finish: string | null, hasCalls: boolean): ModelMessage["stop_reason"] {
  switch (finish) {
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "refusal";
    default:
      // Some endpoints send no reason at all: what the reply holds says it.
      return hasCalls ? "tool_use" : "end_turn";
  }
}

/**
 * Usage as Anthropic counts it (DESIGN.md §5.2.1): input without what was read from the
 * cache, which Chat Completions counts in the prompt's tokens.
 */
export function usageOf(usage: OpenAI.CompletionUsage | undefined): Anthropic.Beta.BetaUsage {
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    input_tokens: Math.max(0, (usage?.prompt_tokens ?? 0) - cached),
    output_tokens: usage?.completion_tokens ?? 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  } as Anthropic.Beta.BetaUsage;
}

/** An OpenAI SDK error as the Anthropic SDK's, status and message kept. */
export function asAnthropicError(err: unknown): unknown {
  if (err instanceof OpenAI.APIConnectionError) {
    return new Anthropic.APIConnectionError({ message: err.message });
  }
  if (err instanceof OpenAI.APIError && err.status !== undefined) {
    const said =
      (err.error as { message?: string } | undefined)?.message ?? err.message ?? "request failed";
    return Anthropic.APIError.generate(
      err.status,
      { type: "error", error: { type: "invalid_request_error", message: said } },
      said,
      new Headers(),
    );
  }
  return err;
}
