import Anthropic from "@anthropic-ai/sdk";

export type ModelRequest = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type ModelMessage = Anthropic.Beta.BetaMessage;

export interface StreamHandlers {
  onText?(delta: string): void;
}

/** The only seam between the agent loop and the API, so the loop can be tested with a fake. */
export interface ModelClient {
  stream(
    request: ModelRequest,
    handlers: StreamHandlers,
    signal: AbortSignal,
  ): Promise<ModelMessage>;
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
    return stream.finalMessage();
  }
}

const FALLBACK_MODELS = new Set([
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
]);

/**
 * Request features not every model accepts; sending them to the wrong model is a 400.
 * Unknown models are assumed to support effort but not the refusal fallback.
 */
export function modelCapabilities(model: string): { effort: boolean; fallbacks: boolean } {
  return {
    effort: !model.startsWith("claude-haiku"),
    fallbacks: FALLBACK_MODELS.has(model),
  };
}

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
