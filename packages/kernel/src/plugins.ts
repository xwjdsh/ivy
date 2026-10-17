import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  CommandDef,
  IvyPlugin,
  RiskLevel,
  SessionInfo,
  ToolContext,
  ToolDef,
  TurnInfo,
} from "@ivy/plugin-api";
import { z } from "zod";
import { createLogger } from "./log.ts";
import { contextBlock } from "./turn-context.ts";

/** Separator between plugin id and tool name. Dots are not allowed in API tool names. */
const SEP = "__";
const NAME_RE = /^[a-zA-Z0-9_-]+$/;
const COMMAND_RE = /^\/[a-z][a-z0-9-]*$/;

/** Per-plugin limits for contextFor, so one plugin can't bloat or stall a turn. */
export const CONTEXT_MAX_CHARS = 2000;
export const CONTEXT_TIMEOUT_MS = 1000;
/**
 * Per-plugin limits for sessionPrompt. Room for the memory plugin's two hot files at their
 * largest settings (20,000 + 50,000 chars) plus headers: they must arrive whole.
 */
export const SESSION_PROMPT_MAX_CHARS = 80_000;
export const SESSION_PROMPT_TIMEOUT_MS = 2000;

export interface RegisteredCommand {
  pluginId: string;
  def: CommandDef;
}

export interface RegisteredTool {
  fullName: string;
  pluginId: string;
  def: ToolDef;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

export class PluginHost {
  private readonly plugins = new Map<string, IvyPlugin>();
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly commandMap = new Map<string, RegisteredCommand>();
  /** Plugins turned off with `[plugins.<id>] enabled = false`. */
  readonly disabled: string[] = [];

  constructor(
    private readonly dataRoot: string,
    private readonly configs: Record<string, Record<string, unknown>>,
  ) {}

  async register(plugin: IvyPlugin): Promise<void> {
    if (!NAME_RE.test(plugin.id) || plugin.id.includes(SEP)) {
      throw new Error(`Invalid plugin id "${plugin.id}"`);
    }
    if (this.plugins.has(plugin.id)) throw new Error(`Duplicate plugin "${plugin.id}"`);

    const { enabled = true, ...settings } = this.configs[plugin.id] ?? {};
    if (typeof enabled !== "boolean") {
      throw new Error(`Invalid [plugins.${plugin.id}]: enabled must be true or false`);
    }
    if (!enabled) {
      this.disabled.push(plugin.id);
      return;
    }
    const config = parsePluginConfig(plugin, settings);

    for (const def of plugin.tools ?? []) {
      const fullName = `${plugin.id}${SEP}${def.name}`;
      if (!NAME_RE.test(def.name) || fullName.length > 64) {
        throw new Error(`Invalid tool name "${fullName}"`);
      }
      if (def.defaultAllow && def.risk === "dangerous") {
        throw new Error(`Tool "${fullName}" is dangerous and can't be allowed by default`);
      }
      if (this.tools.has(fullName)) throw new Error(`Duplicate tool "${fullName}"`);
      this.tools.set(fullName, { fullName, pluginId: plugin.id, def });
    }

    for (const def of plugin.commands ?? []) {
      if (!COMMAND_RE.test(def.name)) {
        throw new Error(`Invalid command name "${def.name}" in plugin "${plugin.id}"`);
      }
      const existing = this.commandMap.get(def.name);
      if (existing) {
        throw new Error(
          `Command ${def.name} is defined by both "${existing.pluginId}" and "${plugin.id}"`,
        );
      }
      this.commandMap.set(def.name, { pluginId: plugin.id, def });
    }

    const dataDir = join(this.dataRoot, plugin.id);
    mkdirSync(dataDir, { recursive: true });
    await plugin.setup?.({
      config,
      dataDir,
      log: createLogger(plugin.id),
    });
    this.plugins.set(plugin.id, plugin);
  }

  async teardown(): Promise<void> {
    for (const plugin of this.plugins.values()) await plugin.teardown?.();
  }

  list(): IvyPlugin[] {
    return [...this.plugins.values()];
  }

  /** Slash commands contributed by plugins, sorted by name. */
  commands(): RegisteredCommand[] {
    return [...this.commandMap.values()].sort((a, b) => a.def.name.localeCompare(b.def.name));
  }

  getCommand(name: string): RegisteredCommand | undefined {
    return this.commandMap.get(name);
  }

  /**
   * Build this turn's `<context>` block from every plugin's contextFor, in plugin-id order.
   * Each is capped in size and time; a failing or slow plugin is skipped, never the turn.
   */
  async turnContext(turn: TurnInfo): Promise<string> {
    const parts = await this.collect(
      "contextFor",
      (p) => p.contextFor?.(turn),
      CONTEXT_MAX_CHARS,
      CONTEXT_TIMEOUT_MS,
    );
    return contextBlock(parts);
  }

  /**
   * Every plugin's system prompt section for a session, in plugin-id order. Same rules as
   * turnContext: capped in size and time, a failing or slow plugin is skipped.
   */
  sessionPrompts(session: SessionInfo): Promise<Array<{ id: string; text: string }>> {
    return this.collect(
      "sessionPrompt",
      (p) => p.sessionPrompt?.(session),
      SESSION_PROMPT_MAX_CHARS,
      SESSION_PROMPT_TIMEOUT_MS,
    );
  }

  private async collect(
    what: string,
    call: (p: IvyPlugin) => Promise<string | null> | string | null | undefined,
    maxChars: number,
    timeoutMs: number,
  ): Promise<Array<{ id: string; text: string }>> {
    const results = await Promise.all(
      this.list()
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(async (p) => {
          try {
            const text = await withTimeout(Promise.resolve(call(p) ?? null), timeoutMs);
            return text?.trim() ? { id: p.id, text: cap(text.trim(), maxChars) } : null;
          } catch (err) {
            createLogger(p.id).warn(`${what} skipped`, errorMessage(err));
            return null;
          }
        }),
    );
    return results.filter((r) => r !== null);
  }

  getTool(fullName: string): RegisteredTool | undefined {
    return this.tools.get(fullName);
  }

  /** Whether the owning plugin lets this tool run without asking (see ToolDef.defaultAllow). */
  isDefaultAllowed(fullName: string): boolean {
    return this.tools.get(fullName)?.def.defaultAllow === true;
  }

  /** Every tool with its declared risk, sorted (for /status). */
  toolList(): Array<{ name: string; risk: RiskLevel; defaultAllow: boolean }> {
    return [...this.tools.values()]
      .sort((a, b) => a.fullName.localeCompare(b.fullName))
      .map(({ fullName, def }) => ({
        name: fullName,
        risk: def.risk,
        defaultAllow: !!def.defaultAllow,
      }));
  }

  riskOf(fullName: string): RiskLevel | undefined {
    return this.tools.get(fullName)?.def.risk;
  }

  /** Tool definitions for the API, sorted so the request prefix stays byte-stable for caching. */
  apiTools(): Anthropic.Beta.BetaTool[] {
    return [...this.tools.values()]
      .sort((a, b) => a.fullName.localeCompare(b.fullName))
      .map(({ fullName, def }) => ({
        name: fullName,
        description: def.description,
        input_schema: toInputSchema(def.input),
        eager_input_streaming: true,
      }));
  }

  /** Static plugin instructions, in a deterministic order. */
  instructions(): string[] {
    return this.list()
      .sort((a, b) => a.id.localeCompare(b.id))
      .flatMap((p) => (p.instructions ? [`## Plugin: ${p.id}\n${p.instructions}`] : []));
  }

  /** Validate input and run a tool. Never throws: failures become error results for the model. */
  async call(fullName: string, input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
    const tool = this.tools.get(fullName);
    if (!tool) return { content: `Unknown tool: ${fullName}`, isError: true };

    const parsed = tool.def.input.safeParse(input);
    if (!parsed.success) {
      return { content: `Invalid input:\n${z.prettifyError(parsed.error)}`, isError: true };
    }
    try {
      const result = await tool.def.run(parsed.data, ctx);
      return typeof result === "string"
        ? { content: result, isError: false }
        : { content: result.content, isError: result.isError ?? false };
    } catch (err) {
      return { content: `Tool failed: ${errorMessage(err)}`, isError: true };
    }
  }
}

function parsePluginConfig(plugin: IvyPlugin, settings: Record<string, unknown>): unknown {
  if (!plugin.configSchema) {
    const keys = Object.keys(settings);
    if (keys.length > 0) {
      throw new Error(
        `Invalid [plugins.${plugin.id}]: this plugin has no settings (got ${keys.join(", ")})`,
      );
    }
    return {};
  }
  const parsed = plugin.configSchema.safeParse(settings);
  if (!parsed.success) {
    throw new Error(`Invalid [plugins.${plugin.id}]:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function toInputSchema(schema: z.ZodType): Anthropic.Beta.BetaTool.InputSchema {
  const { $schema: _, ...json } = z.toJSONSchema(schema, { io: "input" }) as Record<
    string,
    unknown
  >;
  return { ...json, type: "object" } as Anthropic.Beta.BetaTool.InputSchema;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
