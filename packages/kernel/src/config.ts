import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);

const ConfigSchema = z.object({
  model: z
    .object({
      name: z.string().default("claude-opus-5-5"),
      /** Required to call the API. Environment variables are intentionally not used. */
      api_key: z.string().optional(),
      base_url: z.url().default("https://api.anthropic.com"),
      effort: Effort.default("medium"),
      max_tokens: z.number().int().positive().default(64000),
      /** Server-side refusal fallback (`fallbacks: "default"`). */
      fallbacks: z.boolean().default(true),
    })
    .prefault({}),
  agent: z
    .object({
      /** Max model calls per user turn before the loop stops. */
      max_steps: z.number().int().positive().default(25),
    })
    .prefault({}),
  plugins: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
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
    throw new Error(`Invalid ${paths.config}:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
