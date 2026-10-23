import Anthropic from "@anthropic-ai/sdk";

export type ModelRequest = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type ModelMessage = Anthropic.Beta.BetaMessage;

export interface StreamHandlers {
  onText?(delta: string): void;
  /** Each block once it is complete, in order (to show the vendor's searches as they run). */
  onBlock?(block: ModelMessage["content"][number]): void;
}

/**
 * What a request may carry besides the Messages API's own fields, for a client that speaks
 * another protocol (DESIGN.md §5.2.1); the Anthropic client has no use for it.
 */
export interface RequestExtras {
  /** Ask for usage at the end of the stream (Chat Completions' `stream_options`). */
  streamUsage?: boolean;
  /** A key the endpoint may route the prompt cache by (the session's id). */
  cacheKey?: string;
}

/**
 * The only seam between the agent loop and an API, so the loop can be tested with a fake.
 * Requests and replies are in Ivy's own format, the Messages API's; a client for another
 * protocol translates at its edge.
 */
export interface ModelClient {
  stream(
    request: ModelRequest,
    handlers: StreamHandlers,
    signal: AbortSignal,
    extras?: RequestExtras,
  ): Promise<ModelMessage>;
  /** The endpoint's models (with capabilities on Anthropic's Models API). */
  listModels?(): Promise<Anthropic.Models.ModelInfo[]>;
}

export class AnthropicModelClient implements ModelClient {
  private readonly client: Anthropic;

  /**
   * Credentials and endpoint come only from Ivy's config. Passing all three explicitly
   * stops the SDK from picking up ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN /
   * ANTHROPIC_BASE_URL or a local `ant` profile.
   */
  constructor(opts: { apiKey: string; baseURL: string }) {
    this.client = new Anthropic({ apiKey: opts.apiKey, authToken: null, baseURL: opts.baseURL });
  }

  async stream(
    request: ModelRequest,
    handlers: StreamHandlers,
    signal: AbortSignal,
  ): Promise<ModelMessage> {
    const stream = this.client.beta.messages.stream(request, { signal });
    if (handlers.onText) stream.on("text", handlers.onText);
    if (handlers.onBlock) stream.on("contentBlock", handlers.onBlock);
    return stream.finalMessage();
  }

  async listModels(): Promise<Anthropic.Models.ModelInfo[]> {
    const models: Anthropic.Models.ModelInfo[] = [];
    for await (const info of this.client.models.list()) models.push(info);
    return models;
  }
}

const OFFICIAL_HOSTS = { anthropic: "api.anthropic.com", openai: "api.openai.com" } as const;

/**
 * The vendor's own API for a protocol, told by `base_url` alone: what is the vendor's alone
 * goes there only (DESIGN.md §5.2.1). A proxy in front of it counts as any other endpoint.
 */
export function isOfficialApi(type: keyof typeof OFFICIAL_HOSTS, baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === OFFICIAL_HOSTS[type];
  } catch {
    return false;
  }
}

/** Anthropic's own API. Compatible endpoints (proxies) may not support its newest features. */
export const isOfficialAnthropicApi = (baseUrl: string) => isOfficialApi("anthropic", baseUrl);

/** An endpoint as replies record where they came from: its URL without a trailing slash. */
export const endpointKey = (baseUrl: string) => baseUrl.replace(/\/+$/, "");

// USD per million tokens. Cache writes use the 5-minute TTL rate (1.25x input).
const PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
};

/** Estimated cost of one response, or null for models without a known price. */
export function estimateCost(model: string, usage: Anthropic.Beta.BetaUsage): number | null {
  const price = PRICING[model];
  if (!price) return null;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  return (
    (usage.input_tokens * price.input +
      cacheWrite * price.input * 1.25 +
      cacheRead * price.cacheRead +
      usage.output_tokens * price.output) /
    1_000_000
  );
}
