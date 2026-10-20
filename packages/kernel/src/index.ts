import { join } from "node:path";
import type { IvyPlugin } from "@ivy/plugin-api";
import { Agent, type ToolCallRequest } from "./agent.ts";
import { Capabilities } from "./capabilities.ts";
import {
  type Config,
  loadConfig,
  modelChoices,
  type Paths,
  type ProviderConfig,
  resolvePaths,
} from "./config.ts";
import { saveAllowRule } from "./config-edit.ts";
import { SystemPrompt } from "./context.ts";
import { AnthropicModelClient, type ModelClient } from "./model.ts";
import { type PermissionChoice, Permissions } from "./permissions.ts";
import { PluginHost } from "./plugins.ts";
import { sessionHistory } from "./session.ts";
import { pruneTraces, Tracer } from "./trace.ts";

export * from "./agent.ts";
export * from "./capabilities.ts";
export * from "./config.ts";
export * from "./config-edit.ts";
export { type PromptPart, SystemPrompt } from "./context.ts";

import { errorMessage } from "./log.ts";

export { createLogger, errorMessage, type LogLevel, setLogLevel, setLogSink } from "./log.ts";
export * from "./model.ts";
export * from "./permissions.ts";
export * from "./plugins.ts";
export * from "./session.ts";
export * from "./trace.ts";
export * from "./turn-context.ts";
export * from "./usage.ts";

export interface IvyOptions {
  plugins: IvyPlugin[];
  confirm(call: ToolCallRequest): Promise<PermissionChoice>;
  paths?: Paths;
  /** One client for every provider, instead of real ones (tests). */
  model?: ModelClient;
  /** How the current UI shows replies (e.g. "renders Markdown"), added to the system prompt. */
  interfaceInstructions?: string;
}

export interface Ivy {
  agent: Agent;
  plugins: PluginHost;
  config: Config;
  paths: Paths;
  /** Built per session: call `start(id)` when a session starts or is switched to. */
  systemPrompt: SystemPrompt;
  capabilities: Capabilities;
  permissions: Permissions;
  /**
   * What /model offers (see `modelChoices` in config.ts). Endpoints are asked once per run;
   * providers that couldn't be listed are named in `errors`.
   */
  modelChoices(): Promise<{ models: string[]; errors: string[] }>;
  /** Tracer for a session, or undefined when tracing is off. */
  tracer(sessionId: string): Tracer | undefined;
  /**
   * Let a session go (idle): its frozen system prompt and what plugins keep for it. If it
   * comes back, both are built afresh.
   */
  releaseSession(sessionId: string): void;
}

/** Wire up the kernel: config, plugins, system prompt and agent. */
export async function createIvy(opts: IvyOptions): Promise<Ivy> {
  const paths = opts.paths ?? resolvePaths();
  const config = loadConfig(paths);
  pruneTraces(paths.traces, config.trace.retention_days);
  const plugins = new PluginHost(paths.data, config.plugins, sessionHistory(paths.sessions));
  for (const plugin of opts.plugins) await plugins.register(plugin);

  const systemPrompt = new SystemPrompt(paths, plugins, opts.interfaceInstructions);
  const capabilities = new Capabilities(paths.modelsCache, config.generation.effort);
  const clients = new Map<string, ModelClient>();
  const clientFor = (provider: ProviderConfig): ModelClient => {
    let client = clients.get(provider.name);
    if (!client) {
      client = opts.model ?? createModelClient(provider, paths);
      clients.set(provider.name, client);
      // Refresh model facts in the background; nothing waits on the network.
      const lister = client.listModels?.bind(client);
      if (lister) void capabilities.refresh(provider, { listModels: lister });
    }
    return client;
  };
  clientFor(config.model.provider); // a missing API key fails at startup, not on the first turn

  const permissions = new Permissions(
    config.permissions,
    (tool) => saveAllowRule(paths, tool),
    (tool) => plugins.isDefaultAllowed(tool),
  );

  const agent = new Agent({
    config,
    clientFor,
    capabilities,
    permissions,
    plugins,
    systemPrompt: (sessionId) => systemPrompt.textFor(sessionId),
    confirm: opts.confirm,
  });
  const upstream = new Map<string, Promise<string[]>>();
  const listUpstream = (provider: ProviderConfig): Promise<string[]> => {
    let list = upstream.get(provider.name);
    if (!list) {
      list = (async () => {
        const client = clientFor(provider);
        if (!client.listModels) throw new Error("this endpoint can't list its models");
        return (await client.listModels()).map((m) => m.id);
      })();
      // A failure isn't kept: the next /model asks again.
      list.catch(() => upstream.delete(provider.name));
      upstream.set(provider.name, list);
    }
    return list;
  };
  const choices = async () => {
    const lists: Record<string, string[]> = {};
    const errors: string[] = [];
    const open = Object.values(config.providers).filter((p) => p.models.length === 0);
    await Promise.all(
      open.map(async (p) => {
        try {
          lists[p.name] = await listUpstream(p);
        } catch (err) {
          errors.push(`${p.name}: ${errorMessage(err)}`);
        }
      }),
    );
    return { models: modelChoices(config, agent.model, lists), errors };
  };

  const tracer = (sessionId: string) =>
    config.trace.enabled ? new Tracer(join(paths.traces, sessionId)) : undefined;
  return {
    agent,
    plugins,
    config,
    paths,
    systemPrompt,
    capabilities,
    permissions,
    modelChoices: choices,
    tracer,
    releaseSession(id) {
      systemPrompt.end(id);
      plugins.releaseSession({ id });
    },
  };
}

/** The client for a provider's API kind. */
function createModelClient(p: ProviderConfig, paths: Paths): ModelClient {
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
