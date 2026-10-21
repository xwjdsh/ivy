import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
const Effort = z.enum(EFFORT_LEVELS);

/**
 * The protocols Ivy speaks (DESIGN.md §5.2.1): `anthropic`, the Messages API; `openai`,
 * Chat Completions. Adding one also needs a ModelClient (see createModelClient).
 */
export const PROVIDER_TYPES = ["anthropic", "openai"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

/**
 * Where a provider without `base_url` is reached: its vendor's own API. OpenAI's clients take
 * the URL with its `/v1`, Anthropic's without.
 */
export const DEFAULT_BASE_URLS: Record<ProviderType, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
};

/** One way to reach a model API. Several can be configured; models name theirs (`agent.model`). */
const ProviderSchema = z.strictObject({
  /** API kind; see PROVIDER_TYPES. */
  type: z
    .enum(PROVIDER_TYPES, {
      error: (issue) =>
        `unsupported provider type ${JSON.stringify(issue.input)}; supported: ${PROVIDER_TYPES.map((t) => `"${t}"`).join(", ")}`,
    })
    .default("anthropic"),
  /** Required to call the API. Environment variables are intentionally not used. */
  api_key: z.string().optional(),
  /** Unset: the vendor's own API for `type` (DEFAULT_BASE_URLS). */
  base_url: z.url().optional(),
  /**
   * Models /model offers on this provider (by id, without the provider prefix). Unset or
   * empty: no limit, /model offers whatever the endpoint lists.
   */
  models: z.array(z.string().min(1)).default([]),
  /**
   * Server-side refusal fallback where supported: if the model declines, Anthropic re-runs
   * the request on a fallback model (a notice says so). Anthropic recommends it on; set
   * false to see refusals instead.
   */
  refusal_fallback: z.boolean().default(true),
});

// Strict objects: an unknown or misspelled key is an error, not silently ignored.
const ConfigSchema = z.strictObject({
  providers: z.record(z.string(), ProviderSchema).default({}),
  generation: z
    .strictObject({
      effort: Effort.default("medium"),
      max_tokens: z.number().int().positive().default(64000),
    })
    .prefault({}),
  agent: z
    .strictObject({
      /** The model to use, as "<provider>/<model id>" (see resolveModel). None until one is chosen. */
      model: z.string().min(1).optional(),
      /** Max model calls per user turn before the loop stops. */
      max_steps: z.number().int().positive().default(25),
    })
    .prefault({}),
  /** Tool-name globs; see permissions.ts for the order they are checked in. */
  permissions: z
    .strictObject({
      allow: z.array(z.string().min(1)).default([]),
      ask: z.array(z.string().min(1)).default([]),
      deny: z.array(z.string().min(1)).default([]),
    })
    .prefault({}),
  trace: z
    .strictObject({
      /** Write every model request/response to traces/ (see trace.ts). */
      enabled: z.boolean().default(true),
      /** Delete trace folders older than this on startup; 0 keeps them forever. */
      retention_days: z.number().int().min(0).default(7),
    })
    .prefault({}),
  plugins: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
});

export type ProviderConfig = Omit<z.infer<typeof ProviderSchema>, "base_url"> & {
  name: string;
  base_url: string;
};

/**
 * A model reference, "<provider>/<model id>", resolved: the part before the first "/" names
 * a [providers.*] entry, the rest is the model id as that provider knows it, slashes and
 * all ("magpie/codex/gpt-6-luna" is model "codex/gpt-6-luna" on provider "magpie").
 */
export interface ModelRef {
  /** The reference as written. */
  ref: string;
  provider: ProviderConfig;
  /** The model id sent to the provider. */
  id: string;
}

export type Config = Omit<z.infer<typeof ConfigSchema>, "providers"> & {
  providers: Record<string, ProviderConfig>;
  /** `agent.model`, resolved; none before one is chosen (a new install). */
  model?: ModelRef;
};
export type Effort = z.infer<typeof Effort>;

export interface Paths {
  home: string;
  config: string;
  /** SOUL.md: who Ivy is (personality, tone, rules). */
  soul: string;
  sessions: string;
  traces: string;
  data: string;
  /** Model capabilities: Models API facts and features learned unsupported. */
  modelsCache: string;
  /** Images attached to a message not sent yet (see images.ts). */
  uploads: string;
  /** The daemon's socket: local clients (the TUI, the app) talk to it here. */
  daemonSocket: string;
  /** The daemon's own state (e.g. which reminders it announced), apart from plugin data. */
  daemonState: string;
}

export function resolvePaths(home = process.env.IVY_HOME ?? join(homedir(), ".ivy")): Paths {
  home = resolve(home);
  return {
    home,
    config: join(home, "config.toml"),
    soul: join(home, "SOUL.md"),
    sessions: join(home, "sessions"),
    traces: join(home, "traces"),
    data: join(home, "data"),
    modelsCache: join(home, "cache", "models.json"),
    uploads: join(home, "cache", "uploads"),
    daemonSocket: join(home, "daemon.sock"), // also in app/paths.go
    daemonState: join(home, "daemon"),
  };
}

export function loadConfig(paths: Paths): Config {
  const raw = existsSync(paths.config) ? Bun.TOML.parse(readFileSync(paths.config, "utf8")) : {};
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid ${paths.config}:\n${z.prettifyError(parsed.error)}\nSee examples/config.toml for the format.`,
    );
  }
  const providers: Record<string, ProviderConfig> = {};
  for (const [name, p] of Object.entries(parsed.data.providers)) {
    // Model references split at the first "/", so a name with one could never be used.
    if (name.includes("/")) {
      throw new Error(
        `Invalid ${paths.config}: [providers."${name}"]: a provider name can't contain '/'`,
      );
    }
    providers[name] = {
      ...p,
      name,
      base_url: p.base_url ?? DEFAULT_BASE_URLS[p.type],
      models: [...new Set(p.models)],
    };
  }
  const ref = parsed.data.agent.model;
  if (!ref) return { ...parsed.data, providers };
  try {
    return { ...parsed.data, providers, model: resolveModel(providers, ref) };
  } catch (err) {
    throw new Error(`Invalid ${paths.config}: agent.model: ${(err as Error).message}`);
  }
}

/** Resolve "<provider>/<model id>" against the configured providers; throws if it can't. */
export function resolveModel(providers: Record<string, ProviderConfig>, ref: string): ModelRef {
  const slash = ref.indexOf("/");
  const name = ref.slice(0, Math.max(0, slash));
  const id = ref.slice(slash + 1);
  if (slash <= 0 || !id) {
    throw new Error(`"${ref}" should be "<provider>/<model id>", e.g. "anthropic/claude-opus-5-5"`);
  }
  const provider = providers[name];
  if (!provider) {
    const known = Object.keys(providers).join(", ") || "none";
    throw new Error(`"${ref}": no [providers.${name}] section (configured: ${known})`);
  }
  return { ref, provider, id };
}

/**
 * What /model offers: each provider's `models`, or for a provider without that limit, what
 * its endpoint lists (`upstream`, by provider name); and the current model if it isn't
 * among them.
 */
export function modelChoices(
  config: Config,
  current = config.model?.ref,
  upstream: Record<string, string[]> = {},
): string[] {
  const listed = Object.values(config.providers).flatMap((p) =>
    (p.models.length ? p.models : (upstream[p.name] ?? [])).map((id) => `${p.name}/${id}`),
  );
  const unique = [...new Set(listed)];
  return !current || unique.includes(current) ? unique : [current, ...unique];
}

/**
 * Whether /model has anything to offer: a provider without a limit, or two models listed,
 * or, with none chosen yet, any.
 */
export function canSwitchModel(config: Config): boolean {
  const providers = Object.values(config.providers);
  const listed = modelChoices(config).length;
  return providers.some((p) => p.models.length === 0) || listed > (config.model ? 1 : 0);
}
