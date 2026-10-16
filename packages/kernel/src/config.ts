import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);

/** API kinds Ivy can talk to. Adding one also needs a ModelClient (see createModelClient). */
export const PROVIDER_TYPES = ["anthropic"] as const;

/** One way to reach a model API. Several can be configured; `agent.provider` picks one. */
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
  base_url: z.url().default("https://api.anthropic.com"),
  /** Model used at startup. */
  default_model: z.string().min(1),
  /** Other models /model can switch to; default_model is always included. */
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
      /** Which entry of `providers` to use. */
      provider: z.string().default("anthropic"),
      /** Max model calls per user turn before the loop stops. */
      max_steps: z.number().int().positive().default(25),
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

export type ProviderConfig = z.infer<typeof ProviderSchema> & { name: string };

export type Config = Omit<z.infer<typeof ConfigSchema>, "providers"> & {
  providers: Record<string, ProviderConfig>;
  /** The provider selected by `agent.provider`. */
  activeProvider: ProviderConfig;
};
export type Effort = z.infer<typeof Effort>;

export interface Paths {
  home: string;
  config: string;
  /** SOUL.md: who Ivy is (personality, tone, rules). */
  soul: string;
  /** USER.md: who the user is. */
  user: string;
  sessions: string;
  traces: string;
  data: string;
}

export function resolvePaths(home = process.env.IVY_HOME ?? join(homedir(), ".ivy")): Paths {
  home = resolve(home);
  return {
    home,
    config: join(home, "config.toml"),
    soul: join(home, "SOUL.md"),
    user: join(home, "USER.md"),
    sessions: join(home, "sessions"),
    traces: join(home, "traces"),
    data: join(home, "data"),
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
    // default_model first, then the others without duplicates.
    const models = [...new Set([p.default_model, ...p.models])];
    providers[name] = { ...p, name, models };
  }
  const selected = parsed.data.agent.provider;
  const activeProvider = providers[selected];
  if (!activeProvider) {
    const known = Object.keys(providers).join(", ") || "none";
    throw new Error(
      `Invalid ${paths.config}: agent.provider "${selected}" has no [providers.${selected}] section (configured: ${known})`,
    );
  }
  return { ...parsed.data, providers, activeProvider };
}
