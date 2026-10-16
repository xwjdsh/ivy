import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "./config.ts";
import { createLogger } from "./log.ts";

/**
 * What a model supports on the active endpoint, resolved from three sources:
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

const EFFORT_ORDER: Effort[] = ["low", "medium", "high", "xhigh", "max"];
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

export class Capabilities {
  private cache: Record<string, EndpointCache> = {};
  private readonly log = createLogger("capabilities");

  constructor(
    private readonly cacheFile: string,
    /** The active provider's base URL; caches are kept per endpoint. */
    private readonly endpoint: string,
    private readonly official: boolean,
    private readonly settings: { effort: Effort; refusalFallback: boolean },
  ) {
    try {
      if (existsSync(cacheFile)) this.cache = JSON.parse(readFileSync(cacheFile, "utf8"));
    } catch {
      this.cache = {};
    }
  }

  private get entry(): EndpointCache {
    let entry = this.cache[this.endpoint];
    if (!entry) {
      entry = { models: {}, unsupported: {} };
      this.cache[this.endpoint] = entry;
    }
    return entry;
  }

  for(model: string): ResolvedCapabilities {
    const facts = this.entry.models[model];
    const off = new Set(this.entry.unsupported[model] ?? []);
    const claude = model.startsWith("claude-");
    const modern = this.official && claude && !OLD_MODEL.test(model);

    let effort: Effort | undefined = this.settings.effort;
    if (off.has("effort") || facts?.effortSupported === false || model.startsWith("claude-haiku")) {
      effort = undefined;
    } else if (facts?.effortLevels?.length) {
      effort = nearestLevel(this.settings.effort, facts.effortLevels);
    }

    return {
      effort,
      fallbacks: modern && this.settings.refusalFallback && !off.has("fallbacks"),
      systemMessages: modern && !off.has("systemMessages"),
      maxTokens: facts?.maxTokens,
    };
  }

  /** Turn a feature off for a model after the endpoint rejected it; remembered on disk. */
  markUnsupported(model: string, feature: OptionalFeature): void {
    const list = this.entry.unsupported[model] ?? [];
    if (!list.includes(feature)) list.push(feature);
    this.entry.unsupported[model] = list;
    this.save();
  }

  /** Refresh model facts from the Models API if stale. Official endpoint only; never throws. */
  async refresh(lister: ModelLister, now = Date.now()): Promise<void> {
    if (!this.official) return;
    const fetchedAt = this.entry.fetchedAt ? Date.parse(this.entry.fetchedAt) : 0;
    if (now - fetchedAt < CACHE_TTL_MS) return;
    try {
      const models: Record<string, ModelFacts> = {};
      for (const info of await lister.listModels()) models[info.id] = factsOf(info);
      this.entry.models = models;
      this.entry.fetchedAt = new Date(now).toISOString();
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
      ? EFFORT_ORDER.filter((level) => (effort[level] as { supported: boolean } | null)?.supported)
      : undefined,
    maxTokens: info.max_tokens ?? undefined,
  };
}

/** The configured level if supported, else the closest lower one, else the lowest supported. */
function nearestLevel(wanted: Effort, supported: Effort[]): Effort | undefined {
  const index = EFFORT_ORDER.indexOf(wanted);
  for (let i = index; i >= 0; i--) {
    const level = EFFORT_ORDER[i];
    if (level && supported.includes(level)) return level;
  }
  return EFFORT_ORDER.find((level) => supported.includes(level));
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
