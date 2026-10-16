import { join } from "node:path";
import type { IvyPlugin } from "@ivy/plugin-api";
import { Agent, type ToolCallRequest } from "./agent.ts";
import { Capabilities } from "./capabilities.ts";
import { type Config, loadConfig, type Paths, resolvePaths } from "./config.ts";
import { buildSystemPrompt, systemPromptParts } from "./context.ts";
import { AnthropicModelClient, isOfficialAnthropicApi, type ModelClient } from "./model.ts";
import { PluginHost } from "./plugins.ts";
import { pruneTraces, Tracer } from "./trace.ts";

export * from "./agent.ts";
export * from "./capabilities.ts";
export * from "./config.ts";
export * from "./config-edit.ts";
export { createLogger, type LogLevel, setLogLevel, setLogSink } from "./log.ts";
export * from "./model.ts";
export * from "./plugins.ts";
export * from "./session.ts";
export * from "./trace.ts";
export * from "./turn-context.ts";
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
  /** The system prompt's sections with names (verbose view). */
  systemPromptParts: Array<{ name: string; text: string }>;
  capabilities: Capabilities;
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
  const p = config.activeProvider;
  const capabilities = new Capabilities(
    join(paths.home, "cache", "models.json"),
    p.base_url,
    isOfficialAnthropicApi(p.base_url),
    { effort: config.generation.effort, refusalFallback: p.refusal_fallback },
  );
  const model = opts.model ?? createModelClient(config, paths);
  // Refresh model facts in the background; startup never waits on the network.
  const lister = model.listModels?.bind(model);
  if (lister) void capabilities.refresh({ listModels: lister });

  const agent = new Agent({
    config,
    model,
    capabilities,
    plugins,
    systemPrompt,
    confirm: opts.confirm,
  });
  const tracer = (sessionId: string) =>
    config.trace.enabled ? new Tracer(join(paths.traces, sessionId)) : undefined;
  const parts = systemPromptParts(paths, plugins, opts.interfaceInstructions);
  return {
    agent,
    plugins,
    config,
    paths,
    systemPrompt,
    systemPromptParts: parts,
    capabilities,
    tracer,
  };
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
