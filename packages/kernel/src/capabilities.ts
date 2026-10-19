import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { EFFORT_LEVELS, type Effort } from "./config.ts";
import { createLogger } from "./log.ts";
import { isOfficialAnthropicApi } from "./model.ts";

/**
 * What a model supports on its provider's endpoint, resolved from three sources:
 *
 * 1. The Models API (official endpoint only), cached on disk for a day: effort and its
 *    levels, max output tokens. New models need no code change.
 * 2. Features learned to be unsupported at runtime: a request using an optional feature
 *    failed with a 400 naming it, so it is turned off for that model (and remembered).
 * 3. Defaults: Anthropic-only features are tried on the official API with Claude models,
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
}

/** Optional request features that can be learned to be unsupported. */
export type OptionalFeature = "effort" | "fallbacks" | "systemMessages";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Models from before these features existed. This list only covers the past, so new
 * models never need adding; anything newer is tried and downgraded on a 400.
 */
const OLD_MODEL = /^claude-(3|haiku|sonnet-4|sonnet-5$|opus-4-[0-7])/;

interface ModelFacts {
  effortSupported?: boolean;
  effortLevels?: Effort[];
  maxTokens?: number;
}

interface EndpointCache {
  fetchedAt?: string;
  models: Record<string, ModelFacts>;
  unsupported: Record<string, OptionalFeature[]>;
}

export interface ModelLister {
  listModels(): Promise<Anthropic.Models.ModelInfo[]>;
}

/** The provider settings capabilities depend on (a ProviderConfig has them). */
export interface Endpoint {
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
  private readonly log = createLogger("capabilities");

  constructor(
    /** One file for all endpoints, keyed by base URL. */
    private readonly cacheFile: string,
    /** The configured effort, for every model (adjusted per model in `for`). */
    private configuredEffort: Effort,
  ) {
    try {
      if (existsSync(cacheFile)) {
        const data: unknown = JSON.parse(readFileSync(cacheFile, "utf8"));
        // Anything but an object (null, an array, a number) is a broken cache: start over.
        if (data && typeof data === "object" && !Array.isArray(data))
          this.cache = data as typeof this.cache;
      }
    } catch {
      this.cache = {};
    }
  }

  private entry(endpoint: Endpoint): EndpointCache {
    let entry = this.cache[endpoint.base_url];
    if (!entry) {
      entry = { models: {}, unsupported: {} };
      this.cache[endpoint.base_url] = entry;
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
    }

    return {
      effort,
      fallbacks: modern && provider.refusal_fallback && !off.has("fallbacks"),
      systemMessages: modern && !off.has("systemMessages"),
      maxTokens: facts?.maxTokens,
    };
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
    const official = isOfficialAnthropicApi(provider.base_url);
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
    return [
      `endpoint: ${provider.base_url} (${official ? "official Anthropic API" : "compatible"})`,
      `model facts: ${facts ? "from the Models API" : official ? "none cached yet" : "n/a (compatible endpoint)"}`,
      `effort: ${caps.effort ?? "not sent"} (configured ${this.configuredEffort}${facts?.effortLevels ? `; model has ${facts.effortLevels.join("/")}` : ""}${learned.includes("effort") ? "; rejected earlier (learned)" : ""})`,
      `refusal fallback: ${why(caps.fallbacks, "fallbacks", !provider.refusal_fallback ? "off: refusal_fallback = false" : undefined)}`,
      `system messages for context: ${why(caps.systemMessages, "systemMessages")}`,
      ...(caps.maxTokens ? [`max_tokens cap: ${caps.maxTokens}`] : []),
    ];
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
      this.log.warn("model list refresh failed", String(err));
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true });
      writeFileSync(this.cacheFile, JSON.stringify(this.cache, null, 2));
    } catch (err) {
      this.log.warn("could not save capability cache", String(err));
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

/** The configured level if supported, else the closest lower one, else the lowest supported. */
function nearestLevel(wanted: Effort, supported: Effort[]): Effort | undefined {
  const index = EFFORT_LEVELS.indexOf(wanted);
  for (let i = index; i >= 0; i--) {
    const level = EFFORT_LEVELS[i];
    if (level && supported.includes(level)) return level;
  }
  return EFFORT_LEVELS.find((level) => supported.includes(level));
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
  if (m.includes("effort") || m.includes("output_config")) return "effort";
  return null;
}
