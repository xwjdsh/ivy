import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { IvyPlugin } from "@ivy/plugin-api";
import { Agent } from "./agent.ts";
import { Capabilities } from "./capabilities.ts";
import {
  type Config,
  DEFAULT_BASE_URLS,
  loadConfig,
  modelChoices,
  type Paths,
  type ProviderConfig,
  resolvePaths,
} from "./config.ts";
import { saveAllowRule } from "./config-edit.ts";
import { SystemPrompt } from "./context.ts";
import { defaultKeyStore, type KeyStore } from "./keychain.ts";
import { AnthropicModelClient, type ModelClient } from "./model.ts";
import { OpenAIChatClient } from "./openai-model.ts";
import { Permissions } from "./permissions.ts";
import { PluginHost } from "./plugins.ts";
import { sessionHistory } from "./session.ts";
import { pruneTraces, Tracer } from "./trace.ts";

export * from "./agent.ts";
export * from "./capabilities.ts";
export * from "./config.ts";
export * from "./config-edit.ts";
export { type PromptPart, SystemPrompt } from "./context.ts";
export * from "./images.ts";
export * from "./keychain.ts";

import { createLogger, errorMessage } from "./log.ts";

export { createLogger, errorMessage, type LogLevel, setLogLevel, setLogSink } from "./log.ts";
export * from "./model.ts";
export * from "./openai-model.ts";
export * from "./permissions.ts";
export * from "./plugins.ts";
export * from "./session.ts";
export * from "./trace.ts";
export * from "./turn-context.ts";
export * from "./usage.ts";

export interface IvyOptions {
  plugins: IvyPlugin[];
  paths?: Paths;
  /** One client for every provider, instead of real ones (tests). */
  model?: ModelClient;
  /** Where API keys are kept apart from config.toml; the Keychain on macOS by default. */
  keys?: KeyStore;
}

/** Where a provider's API key comes from. */
export type KeySource = "config" | "keychain" | "none";

export interface Ivy {
  agent: Agent;
  plugins: PluginHost;
  config: Config;
  paths: Paths;
  /** Frozen per session: `start(id, …)` when a session starts or is loaded again. */
  systemPrompt: SystemPrompt;
  capabilities: Capabilities;
  permissions: Permissions;
  /**
   * What /model offers (see `modelChoices` in config.ts). Endpoints are asked once per run;
   * providers that couldn't be listed are named in `errors`.
   */
  modelChoices(): Promise<{ models: string[]; errors: string[] }>;
  /** Where API keys are kept apart from config.toml. */
  keys: KeyStore;
  /** Where a provider's key comes from: config.toml first, then the key store. */
  keySource(provider: string): KeySource;
  /**
   * Read the providers from config.toml again, after the settings page changed them: later
   * requests use them, with new clients and model lists.
   */
  reloadProviders(): void;
  /** The models an endpoint lists with this key: a connection test, nothing saved. */
  listModelsAt(endpoint: { type: string; base_url?: string; key: string }): Promise<string[]>;
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
  const keys = opts.keys ?? defaultKeyStore();
  const config = loadConfig(paths);
  pruneTraces(paths.traces, config.trace.retention_days);
  const plugins = new PluginHost(
    paths.data,
    config.plugins,
    sessionHistory(paths.sessions),
    paths.soul,
  );
  for (const plugin of opts.plugins) await plugins.register(plugin);

  const systemPrompt = new SystemPrompt(paths, plugins);
  const capabilities = new Capabilities(paths.modelsCache, config.generation.effort);
  const clients = new Map<string, ModelClient>();
  const clientFor = (provider: ProviderConfig): ModelClient => {
    let client = clients.get(provider.name);
    if (!client) {
      client = opts.model ?? createModelClient(provider, keyOf(provider, keys), paths);
      clients.set(provider.name, client);
      // Refresh model facts in the background; nothing waits on the network.
      const lister = client.listModels?.bind(client);
      if (lister) void capabilities.refresh(provider, { listModels: lister });
    }
    return client;
  };
  // A missing API key is said now, but doesn't stop Ivy: the settings are where it is set,
  // and they need Ivy running. A turn says it again.
  if (config.model) {
    try {
      clientFor(config.model.provider);
    } catch (err) {
      createLogger("ivy").warn(errorMessage(err));
    }
  }

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

  const reloadProviders = () => {
    const fresh = loadConfig(paths);
    for (const name of Object.keys(config.providers)) delete config.providers[name];
    Object.assign(config.providers, fresh.providers);
    clients.clear();
    upstream.clear();
    // The model in use now points at its provider as it is now.
    if (agent.model) agent.setModel(agent.model);
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
    keys,
    keySource(name) {
      const p = config.providers[name];
      return p?.api_key ? "config" : keys.available && keys.get(name) ? "keychain" : "none";
    },
    reloadProviders,
    async listModelsAt({ type, base_url, key }) {
      const kind = type as ProviderConfig["type"];
      const endpoint: ProviderConfig = {
        name: "test",
        type: kind,
        base_url: base_url || DEFAULT_BASE_URLS[kind],
        models: [],
        refusal_fallback: true,
      };
      const client = opts.model ?? createModelClient(endpoint, key, paths);
      if (!client.listModels) throw new UnlistedModels("this endpoint can't list its models");
      try {
        return (await client.listModels()).map((m) => m.id);
      } catch (err) {
        const answered =
          err instanceof Anthropic.APIError &&
          err.status !== undefined &&
          err.status !== 401 &&
          err.status !== 403;
        throw answered ? new UnlistedModels(whyUnreachable(err)) : new Error(whyUnreachable(err));
      }
    },
    tracer,
    releaseSession(id) {
      systemPrompt.end(id);
      plugins.releaseSession({ id });
    },
  };
}

/** A provider's key: config.toml's first, then the key store's. */
function keyOf(p: ProviderConfig, keys: KeyStore): string | undefined {
  return p.api_key ?? (keys.available ? keys.get(p.name) : undefined);
}

/** The client for a provider's API kind. */
function createModelClient(p: ProviderConfig, key: string | undefined, paths: Paths): ModelClient {
  if (!key) {
    throw new Error(
      `No API key for ${p.name}. Set one in Ivy's settings, or api_key under [providers.${p.name}] in ${paths.config}`,
    );
  }
  switch (p.type) {
    case "anthropic":
      return new AnthropicModelClient({ apiKey: key, baseURL: p.base_url });
    case "openai":
      return new OpenAIChatClient({ apiKey: key, baseURL: p.base_url });
    default: {
      // Compile error here when a type is added to PROVIDER_TYPES without a client.
      const unsupported: never = p.type;
      throw new Error(`Unsupported provider type: ${String(unsupported)}`);
    }
  }
}

/** The endpoint answered and took the key, but listed no models: they can be named instead. */
export class UnlistedModels extends Error {}

/** Why an endpoint didn't answer, in a sentence: not the API's raw error body. */
export function whyUnreachable(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    if (err.status === 401 || err.status === 403) {
      return `the endpoint refused the key (${err.status})`;
    }
    if (err.status === undefined) return `couldn't reach the endpoint (${err.message})`;
    const said = (err.error as { error?: { message?: string } } | undefined)?.error?.message;
    return `the endpoint answered ${err.status}${said ? `: ${said}` : ""}`;
  }
  return errorMessage(err);
}
