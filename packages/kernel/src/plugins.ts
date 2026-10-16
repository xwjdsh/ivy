import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { IvyPlugin, RiskLevel, ToolContext, ToolDef } from "@ivy/plugin-api";
import { z } from "zod";
import { createLogger } from "./log.ts";

/** Separator between plugin id and tool name. Dots are not allowed in API tool names. */
const SEP = "__";
const NAME_RE = /^[a-zA-Z0-9_-]+$/;

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

  constructor(
    private readonly dataRoot: string,
    private readonly configs: Record<string, Record<string, unknown>>,
  ) {}

  async register(plugin: IvyPlugin): Promise<void> {
    if (!NAME_RE.test(plugin.id) || plugin.id.includes(SEP)) {
      throw new Error(`Invalid plugin id "${plugin.id}"`);
    }
    if (this.plugins.has(plugin.id)) throw new Error(`Duplicate plugin "${plugin.id}"`);

    for (const def of plugin.tools ?? []) {
      const fullName = `${plugin.id}${SEP}${def.name}`;
      if (!NAME_RE.test(def.name) || fullName.length > 64) {
        throw new Error(`Invalid tool name "${fullName}"`);
      }
      this.tools.set(fullName, { fullName, pluginId: plugin.id, def });
    }

    const dataDir = join(this.dataRoot, plugin.id);
    mkdirSync(dataDir, { recursive: true });
    await plugin.setup?.({
      config: this.configs[plugin.id] ?? {},
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

  getTool(fullName: string): RegisteredTool | undefined {
    return this.tools.get(fullName);
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

  /** Validate input and run a tool. Never throws: failures become error results for Claude. */
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
