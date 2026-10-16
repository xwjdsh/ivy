import { join } from "node:path";
import type { IvyPlugin } from "@ivy/plugin-api";
import { Agent, type ToolCallRequest } from "./agent.ts";
import { type Config, loadConfig, type Paths, resolvePaths } from "./config.ts";
import { buildSystemPrompt } from "./context.ts";
import { AnthropicModelClient, type ModelClient } from "./model.ts";
import { PluginHost } from "./plugins.ts";
import { pruneTraces, Tracer } from "./trace.ts";

export * from "./agent.ts";
export * from "./config.ts";
export { setLogLevel } from "./log.ts";
export * from "./model.ts";
export * from "./plugins.ts";
export * from "./session.ts";
export * from "./trace.ts";
export * from "./usage.ts";

export interface IvyOptions {
  plugins: IvyPlugin[];
  confirm(call: ToolCallRequest): Promise<boolean>;
  paths?: Paths;
  model?: ModelClient;
  /** How the current UI shows replies (e.g. "renders Markdown"), added to the system prompt. */
  interfaceInstructions?: string;
}

export interface Ivy {
  agent: Agent;
  plugins: PluginHost;
  config: Config;
  paths: Paths;
  systemPrompt: string;
  /** Tracer for a session, or undefined when tracing is off. */
  tracer(sessionId: string): Tracer | undefined;
}

/** Wire up the kernel: config, plugins, system prompt and agent. */
export async function createIvy(opts: IvyOptions): Promise<Ivy> {
  const paths = opts.paths ?? resolvePaths();
  const config = loadConfig(paths);
  pruneTraces(paths.traces, config.trace.retention_days);
  const plugins = new PluginHost(paths.data, config.plugins);
  for (const plugin of opts.plugins) await plugins.register(plugin);

  const systemPrompt = buildSystemPrompt(paths, plugins, opts.interfaceInstructions);
  const agent = new Agent({
    config,
    model: opts.model ?? createModelClient(config, paths),
    plugins,
    systemPrompt,
    confirm: opts.confirm,
  });
  const tracer = (sessionId: string) =>
    config.trace.enabled ? new Tracer(join(paths.traces, sessionId)) : undefined;
  return { agent, plugins, config, paths, systemPrompt, tracer };
}

/** The client for the active provider's API kind. */
function createModelClient(config: Config, paths: Paths): ModelClient {
  const p = config.activeProvider;
  if (!p.api_key) {
    throw new Error(`No API key. Set api_key under [providers.${p.name}] in ${paths.config}`);
  }
  switch (p.type) {
    case "anthropic":
      return new AnthropicModelClient({ apiKey: p.api_key, baseURL: p.base_url });
    default: {
      // Compile error here when a type is added to PROVIDER_TYPES without a client.
      const unsupported: never = p.type;
      throw new Error(`Unsupported provider type: ${String(unsupported)}`);
    }
  }
}
