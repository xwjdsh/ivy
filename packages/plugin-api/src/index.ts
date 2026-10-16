// Public contract between Ivy's kernel and its plugins.
// Plugins import only from this package, never from @ivy/kernel.

import type { z } from "zod";

export type RiskLevel = "read" | "write" | "external" | "dangerous";

export type ToolResult = string | { content: string; isError?: boolean };

export interface ToolContext {
  /** Aborted when the user interrupts the turn. */
  signal: AbortSignal;
  log: Logger;
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  /** Local name; exposed to Claude as `<pluginId>__<name>`. Must match [a-zA-Z0-9_-]. */
  name: string;
  description: string;
  input: S;
  risk: RiskLevel;
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult> | ToolResult;
}

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

export interface PluginContext {
  /** Raw `[plugins.<id>]` table from config.toml (validated by the plugin itself). */
  config: Record<string, unknown>;
  /** Private data directory: ~/.ivy/data/<pluginId>/ (created on demand). */
  dataDir: string;
  log: Logger;
}

export interface IvyPlugin {
  id: string;
  version: string;
  description: string;
  setup?(ctx: PluginContext): Promise<void> | void;
  teardown?(): Promise<void> | void;
  tools?: ToolDef[];
  /** Static text appended to the system prompt. Must be deterministic (prompt caching). */
  instructions?: string;
}

/** Identity helper that keeps the input type of `run` inferred from the zod schema. */
export function defineTool<S extends z.ZodType>(tool: ToolDef<S>): ToolDef {
  return tool as unknown as ToolDef;
}

export function definePlugin(plugin: IvyPlugin): IvyPlugin {
  return plugin;
}
