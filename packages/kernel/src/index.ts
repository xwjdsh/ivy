import type { IvyPlugin } from "@ivy/plugin-api";
import { Agent, type ToolCallRequest } from "./agent.ts";
import { type Config, loadConfig, type Paths, resolvePaths } from "./config.ts";
import { buildSystemPrompt } from "./context.ts";
import { AnthropicModelClient, type ModelClient } from "./model.ts";
import { PluginHost } from "./plugins.ts";

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
}

/** Wire up the kernel: config, plugins, system prompt and agent. */
export async function createIvy(opts: IvyOptions): Promise<Ivy> {
  const paths = opts.paths ?? resolvePaths();
  const config = loadConfig(paths);
  const plugins = new PluginHost(paths.data, config.plugins);
  for (const plugin of opts.plugins) await plugins.register(plugin);

  const systemPrompt = buildSystemPrompt(paths, plugins, opts.interfaceInstructions);
  const agent = new Agent({
    config,
    model: opts.model ?? defaultModel(config, paths),
    plugins,
    systemPrompt,
    confirm: opts.confirm,
  });
  return { agent, plugins, config, paths, systemPrompt };
}

function defaultModel(config: Config, paths: Paths): ModelClient {
  if (!config.model.api_key) {
    throw new Error(`No API key. Set [model] api_key in ${paths.config}`);
  }
  return new AnthropicModelClient({ apiKey: config.model.api_key, baseURL: config.model.base_url });
}
