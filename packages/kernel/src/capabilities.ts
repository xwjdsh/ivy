import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { EFFORT_LEVELS, type Effort } from "./config.ts";
import { createLogger, errorMessage } from "./log.ts";
import {
  endpointKey,
  isOfficialAnthropicApi,
  isOfficialApi,
  type ModelClient,
  type ModelRequest,
  type RequestExtras,
} from "./model.ts";

/**
 * What a model supports on its provider's endpoint, resolved from four sources:
 *
 * 1. The Models API (official endpoint only), cached on disk for a day: effort and its
 *    levels, max output tokens. New models need no code change.
 * 2. Features learned to be unsupported at runtime: a request using an optional feature
 *    failed with a 400 naming it, so it is turned off for that model (and remembered).
 * 3. Probed: server-side web search, which a compatible endpoint could ignore without a
 *    trace, is tried once per model there with a small request and kept if the reply shows a
 *    search (see probeWebSearch).
 * 4. Defaults: Anthropic-only features are tried on the official API with Claude models,
 *    except a fixed list of *older* models known to lack them. Compatible endpoints only
 *    get the basics (compatibility first).
 */
export interface ResolvedCapabilities {
  /** Effort to send, or undefined to leave `output_config.effort` out. */
  effort?: Effort;
  /** Server-side refusal fallback (`fallbacks: "default"`). */
  fallbacks: boolean;
  /** Mid-conversation system messages with `clear_at`, for per-turn context. */
  systemMessages: boolean;
  /** Upper bound for `max_tokens`, when the Models API reports one. */
  maxTokens?: number;
  /** Usage at the end of a Chat Completions stream (`stream_options`). */
  streamUsage: boolean;
  /** A prompt cache key on Chat Completions. */
  cacheKey: boolean;
  /** Images the user sent; refused, each is a line saying it was left out. */
  images: boolean;
  /** The server-side web search tool's type, where the model has one here. */
  webSearch?: WebSearchType;
}

export type WebSearchType = "web_search_20260209" | "web_search_20250305";

/** Optional request features that can be learned to be unsupported. */
export type OptionalFeature =
  | "effort"
  | "fallbacks"
  | "systemMessages"
  | "streamUsage"
  | "cacheKey"
  | "images"
  | "webSearch";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Models from before these features existed. This list only covers the past, so new
 * models never need adding; anything newer is tried and downgraded on a 400.
 */
const OLD_MODEL = /^claude-(3|haiku|sonnet-4|sonnet-5$|opus-4-[0-7])/;

/** Models with web search's dynamic filtering; other Claude models get the basic variant. */
const FILTERING_SEARCH = /^claude-(opus-(5|5-5|4-[678])|sonnet-(5|5-5|4-6))$/;

interface ModelFacts {
  effortSupported?: boolean;
  effortLevels?: Effort[];
  maxTokens?: number;
}

interface EndpointCache {
  fetchedAt?: string;
  models: Record<string, ModelFacts>;
  unsupported: Record<string, OptionalFeature[]>;
  /** What probing found, by model: the search tool's type, or false for none. */
  probed?: Record<string, { webSearch: WebSearchType | false; at: string }>;
}

export interface ModelLister {
  listModels(): Promise<Anthropic.Models.ModelInfo[]>;
}

/** The provider settings capabilities depend on (a ProviderConfig has them). */
export interface Endpoint {
  /** The protocol (config.ts PROVIDER_TYPES). */
  type?: string;
  base_url: string;
  refusal_fallback: boolean;
}

/** A model on an endpoint (a ModelRef is one). */
export interface ModelTarget {
  provider: Endpoint;
  id: string;
}

export class Capabilities {
  private cache: Record<string, EndpointCache> = {};
  /** Web search probes under way, by "<endpoint> <model>". */
  private readonly probing = new Map<string, Promise<void>>();
  private readonly log = createLogger("capabilities");

  constructor(
    /** One file for all endpoints, keyed by base URL (endpointKey). */
    private readonly cacheFile: string,
    /** The configured effort, for every model (adjusted per model in `for`). */
    private configuredEffort: Effort,
  ) {
    try {
      if (existsSync(cacheFile)) {
        const data: unknown = JSON.parse(readFileSync(cacheFile, "utf8"));
        // Anything but an object (null, an array, a number) is a broken cache: start over.
        if (data && typeof data === "object" && !Array.isArray(data)) {
          // Kept by endpointKey; one saved under another spelling of its URL joins it.
          for (const [url, entry] of Object.entries(data as Record<string, EndpointCache>)) {
            this.cache[endpointKey(url)] ??= entry;
          }
        }
      }
    } catch {
      this.cache = {};
    }
  }

  private entry(endpoint: Endpoint): EndpointCache {
    // Keyed as replies record their origin, so `https://x/` and `https://x` are one endpoint.
    const key = endpointKey(endpoint.base_url);
    let entry = this.cache[key];
    if (!entry) {
      entry = { models: {}, unsupported: {} };
      this.cache[key] = entry;
    }
    return entry;
  }

  for({ provider, id: model }: ModelTarget): ResolvedCapabilities {
    const entry = this.entry(provider);
    const facts = entry.models[model];
    const off = new Set(entry.unsupported[model] ?? []);
    const claude = model.startsWith("claude-");
    const modern = isOfficialAnthropicApi(provider.base_url) && claude && !OLD_MODEL.test(model);

    let effort: Effort | undefined = this.configuredEffort;
    if (off.has("effort") || facts?.effortSupported === false || model.startsWith("claude-haiku")) {
      effort = undefined;
    } else if (facts?.effortLevels?.length) {
      effort = nearestLevel(this.configuredEffort, facts.effortLevels);
    } else if (provider.type === "openai") {
      // reasoning_effort takes these three everywhere; a higher one would be refused, and
      // effort learned off for the model altogether.
      effort = nearestLevel(this.configuredEffort, ["low", "medium", "high"]);
    }

    return {
      effort,
      fallbacks: modern && provider.refusal_fallback && !off.has("fallbacks"),
      systemMessages: modern && !off.has("systemMessages"),
      maxTokens: facts?.maxTokens,
      // Harmless if ignored, and a 400 if refused: tried everywhere (DESIGN.md §5.2.1).
      streamUsage: !off.has("streamUsage"),
      cacheKey: !off.has("cacheKey"),
      images: !off.has("images"),
      webSearch: off.has("webSearch") ? undefined : this.webSearchFor(provider, model),
    };
  }

  /**
   * The search tool a model has: on Anthropic's own API every Claude model, on another
   * Messages endpoint what a probe found; none on Chat Completions (DESIGN.md §8).
   */
  private webSearchFor(provider: Endpoint, model: string): WebSearchType | undefined {
    if (provider.type === "openai") return undefined;
    if (!isOfficialAnthropicApi(provider.base_url)) {
      return this.entry(provider).probed?.[model]?.webSearch || undefined;
    }
    if (!model.startsWith("claude-")) return undefined;
    return searchTypeFor(model);
  }

  /**
   * Whether web search on this model is still to be probed: a compatible Messages endpoint,
   * not probed yet, or found without it more than a day ago (it may have gained it since).
   */
  needsSearchProbe({ provider, id }: ModelTarget, now = Date.now()): boolean {
    if (provider.type === "openai" || isOfficialAnthropicApi(provider.base_url)) return false;
    if (this.entry(provider).unsupported[id]?.includes("webSearch")) return false;
    const probed = this.entry(provider).probed?.[id];
    return !probed || (!probed.webSearch && now - Date.parse(probed.at) >= CACHE_TTL_MS);
  }

  /**
   * Try web search on a model at a compatible endpoint, when it is due (needsSearchProbe) and
   * not already being tried: a small request that needs a search, kept on if the reply holds
   * one. Refused with the filtering search, the basic one is tried; refused, failed or
   * answered without a search, it is off until tried again a day later. Not reaching the
   * endpoint keeps nothing, so a later turn tries again. Never throws.
   */
  probeWebSearch(target: ModelTarget, client: ModelClient): Promise<void> {
    const key = `${target.provider.base_url} ${target.id}`;
    const running = this.probing.get(key);
    if (running) return running;
    if (!this.needsSearchProbe(target)) return Promise.resolve();
    const probe = this.probe(target, client).finally(() => this.probing.delete(key));
    this.probing.set(key, probe);
    return probe;
  }

  private async probe(target: ModelTarget, client: ModelClient): Promise<void> {
    let found: WebSearchType | false = false;
    for (const type of new Set([searchTypeFor(target.id), "web_search_20250305" as const])) {
      try {
        const reply = await client.stream(
          {
            model: target.id,
            max_tokens: 4096,
            tools: [{ type, name: "web_search", max_uses: 1 }],
            messages: [
              {
                role: "user",
                content:
                  "Search the web once for today's top news headline, then name it in a few words.",
              },
            ],
          },
          {},
          AbortSignal.timeout(PROBE_TIMEOUT_MS),
        );
        found = reply.content.some((b) => b.type === "web_search_tool_result") && type;
        break;
      } catch (err) {
        // Not reached, busy or failing for now: nothing kept, so a later turn tries again.
        const passing =
          err instanceof Anthropic.APIError &&
          (err.status === undefined ||
            err.status === 408 ||
            err.status === 429 ||
            err.status >= 500);
        if (!(err instanceof Anthropic.APIError) || passing) {
          this.log.warn(`web search probe failed for ${target.id}`, errorMessage(err));
          return;
        }
        // An endpoint that refuses the filtering search may take the basic one.
        if (!(err instanceof Anthropic.BadRequestError)) break;
      }
    }
    const entry = this.entry(target.provider);
    entry.probed = {
      ...entry.probed,
      [target.id]: { webSearch: found, at: new Date().toISOString() },
    };
    this.log.info(`web search on ${target.id} at ${target.provider.base_url}: ${found || "none"}`);
    this.save();
  }

  /** The configured effort (before per-model adjustment). */
  get effort(): Effort {
    return this.configuredEffort;
  }

  /** Change the configured effort for later requests (e.g. from /effort). */
  setEffort(effort: Effort): void {
    this.configuredEffort = effort;
  }

  /** Why each optional feature is on or off for a model (verbose view). */
  explain(target: ModelTarget): string[] {
    const { provider, id: model } = target;
    const caps = this.for(target);
    const entry = this.entry(provider);
    const openai = provider.type === "openai";
    const official = isOfficialApi(openai ? "openai" : "anthropic", provider.base_url);
    const facts = entry.models[model];
    const learned = entry.unsupported[model] ?? [];
    const claude = model.startsWith("claude-");
    const oldModel = OLD_MODEL.test(model);
    const why = (on: boolean, feature: OptionalFeature, extra?: string) => {
      if (learned.includes(feature)) return "off: rejected by this endpoint earlier (learned)";
      if (extra) return extra;
      if (on) return "on";
      if (!official) return "off: compatible endpoint";
      if (!claude) return "off: not a Claude model";
      if (oldModel) return "off: older model";
      return "off";
    };
    const capped =
      openai && caps.effort && caps.effort !== this.configuredEffort
        ? "; Chat Completions takes up to high"
        : "";
    return [
      `endpoint: ${provider.base_url} (${openai ? "Chat Completions" : "Messages API"}, ${official ? "the vendor's own" : "compatible"})`,
      `model facts: ${facts ? "from the Models API" : official && !openai ? "none cached yet" : "n/a"}`,
      `effort: ${caps.effort ?? "not sent"} (configured ${this.configuredEffort}${facts?.effortLevels ? `; model has ${facts.effortLevels.join("/")}` : ""}${capped}${learned.includes("effort") ? "; rejected earlier (learned)" : ""})`,
      // What each protocol has of its own (DESIGN.md §5.2.1).
      ...(openai
        ? [
            `usage in the stream: ${why(caps.streamUsage, "streamUsage")}`,
            `prompt cache key: ${why(caps.cacheKey, "cacheKey")}`,
          ]
        : [
            `refusal fallback: ${why(caps.fallbacks, "fallbacks", !provider.refusal_fallback ? "off: refusal_fallback = false" : undefined)}`,
            `system messages for context: ${why(caps.systemMessages, "systemMessages")}`,
          ]),
      `images: ${why(caps.images, "images")}`,
      `web search: ${this.searchStatus(target, caps.webSearch, learned)}`,
      ...(caps.maxTokens ? [`max_tokens cap: ${caps.maxTokens}`] : []),
    ];
  }

  /** Why web search is on or off for a model (`explain`). */
  private searchStatus(
    target: ModelTarget,
    on: WebSearchType | undefined,
    learned: OptionalFeature[],
  ): string {
    const { provider } = target;
    const official = isOfficialAnthropicApi(provider.base_url);
    if (on) return official ? on : `${on} (probed)`;
    if (learned.includes("webSearch")) return "off: rejected by this endpoint earlier (learned)";
    if (provider.type === "openai") return "off: Chat Completions";
    if (official) return "off: not a Claude model";
    return this.entry(provider).probed?.[target.id]
      ? "off: the probe found none"
      : "not probed yet";
  }

  /** Turn a feature off for a model after its endpoint rejected it; remembered on disk. */
  markUnsupported({ provider, id: model }: ModelTarget, feature: OptionalFeature): void {
    const entry = this.entry(provider);
    const list = entry.unsupported[model] ?? [];
    if (!list.includes(feature)) list.push(feature);
    entry.unsupported[model] = list;
    this.save();
  }

  /**
   * Refresh an endpoint's model facts from the Models API if stale. Official endpoint
   * only; never throws.
   */
  async refresh(endpoint: Endpoint, lister: ModelLister, now = Date.now()): Promise<void> {
    if (!isOfficialAnthropicApi(endpoint.base_url)) return;
    const entry = this.entry(endpoint);
    const fetchedAt = entry.fetchedAt ? Date.parse(entry.fetchedAt) : 0;
    if (now - fetchedAt < CACHE_TTL_MS) return;
    try {
      const models: Record<string, ModelFacts> = {};
      for (const info of await lister.listModels()) models[info.id] = factsOf(info);
      entry.models = models;
      entry.fetchedAt = new Date(now).toISOString();
      this.save();
    } catch (err) {
      this.log.warn("model list refresh failed", errorMessage(err));
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true });
      writeFileSync(this.cacheFile, JSON.stringify(this.cache, null, 2));
    } catch (err) {
      this.log.warn("could not save capability cache", errorMessage(err));
    }
  }
}

function factsOf(info: Anthropic.Models.ModelInfo): ModelFacts {
  const effort = info.capabilities?.effort;
  return {
    effortSupported: effort?.supported,
    effortLevels: effort
      ? EFFORT_LEVELS.filter((level) => (effort[level] as { supported: boolean } | null)?.supported)
      : undefined,
    maxTokens: info.max_tokens ?? undefined,
  };
}

const PROBE_TIMEOUT_MS = 120_000;

/** The search tool for a model, by its name: "magpie/claude/claude-opus-5-5" counts as Opus 5.5. */
function searchTypeFor(model: string): WebSearchType {
  const name = model.slice(model.lastIndexOf("/") + 1);
  return FILTERING_SEARCH.test(name) ? "web_search_20260209" : "web_search_20250305";
}

/** The configured level if supported, else the closest lower one, else the lowest supported. */
function nearestLevel(wanted: Effort, supported: Effort[]): Effort | undefined {
  const index = EFFORT_LEVELS.indexOf(wanted);
  for (let i = index; i >= 0; i--) {
    const level = EFFORT_LEVELS[i];
    if (level && supported.includes(level)) return level;
  }
  return EFFORT_LEVELS.find((level) => supported.includes(level));
}

/** The optional features a request carries. */
function optionalUsed(request: ModelRequest, extras: RequestExtras = {}): OptionalFeature[] {
  const isImage = (b: { type: string }) => b.type === "image";
  const used: OptionalFeature[] = [];
  if (request.output_config?.effort !== undefined) used.push("effort");
  if (request.fallbacks !== undefined) used.push("fallbacks");
  if (request.messages.some((m) => m.role === "system")) used.push("systemMessages");
  if (extras.streamUsage) used.push("streamUsage");
  if (extras.cacheKey) used.push("cacheKey");
  if (request.tools?.some((t) => "type" in t && t.type?.startsWith("web_search"))) {
    used.push("webSearch");
  }
  if (request.messages.some((m) => typeof m.content !== "string" && m.content.some(isImage))) {
    used.push("images");
  }
  return used;
}

/**
 * A 400 about an optional feature this request actually used: the feature to turn off for
 * the model before asking again.
 */
export function downgradable(
  err: unknown,
  request: ModelRequest,
  extras?: RequestExtras,
): OptionalFeature | null {
  if (!(err instanceof Anthropic.BadRequestError)) return null;
  const feature = rejectedFeature(err.message);
  return feature && optionalUsed(request, extras).includes(feature) ? feature : null;
}

/**
 * Which optional feature a 400 from the endpoint complains about, if any. Matching on
 * the message is the only option: the API has no structured code for these.
 */
export function rejectedFeature(message: string): OptionalFeature | null {
  const m = message.toLowerCase();
  if (
    m.includes("role 'system'") ||
    m.includes("clear_at") ||
    m.includes("mid-conversation-system")
  ) {
    return "systemMessages";
  }
  if (m.includes("fallbacks") || m.includes("server-side-fallback")) return "fallbacks";
  // Before effort: an endpoint refusing `stream_options` might also mention reasoning.
  if (m.includes("stream_options") || m.includes("include_usage")) return "streamUsage";
  if (m.includes("prompt_cache_key")) return "cacheKey";
  // A model that takes no images, not an image too large (the page keeps them within limits).
  if (
    m.includes("image_url") ||
    m.includes("multimodal") ||
    /\bvision\b/.test(m) ||
    (m.includes("image") && /not support|unsupported|only supported|does not accept/.test(m))
  ) {
    return "images";
  }
  if (m.includes("effort") || m.includes("output_config")) return "effort";
  // The tool refused, not a search block in the history it didn't like.
  if (
    /tools\.\d+.*web_search|web_search\S*.*(not supported|unsupported|unknown|not available)/.test(
      m,
    )
  ) {
    return "webSearch";
  }
  return null;
}
