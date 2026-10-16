import type { AgentEvent, Ivy, RequestInfo } from "@ivy/kernel";
import { compact } from "./usage-report.ts";

type StepEvent = Extract<AgentEvent, { type: "step" }>;

/**
 * One line per model call, printed when it returns. Only what changes per call; static
 * state (model, effort, tools, capabilities) is in the status bar and /status.
 *
 * "step 1 · 5 msgs · context block · end_turn · in 50 out 20 · cache read 3.2k write 120 · 1.5s"
 */
export function formatCall(e: StepEvent, request?: RequestInfo): string {
  const u = e.usage;
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const parts = [`step ${e.step}`];
  if (request) {
    parts.push(`${request.messages} msgs`);
    if (request.hasContext) parts.push(`context ${request.contextMode}`);
  }
  parts.push(e.stopReason ?? "?", `in ${compact(u.input_tokens)} out ${compact(u.output_tokens)}`);
  if (read > 0 || write > 0) parts.push(`cache read ${compact(read)} write ${compact(write)}`);
  parts.push(`${(e.latencyMs / 1000).toFixed(1)}s`);
  if (request && !sameModel(request.model, e.model)) parts.push(`served by ${e.model}`);
  return parts.join(" · ") + (e.traceFile ? `\n  trace: ${e.traceFile}` : "");
}

/**
 * Proxies often report a model without its routing prefix ("vendor/model-a" → "model-a");
 * that is the same model, not a switch.
 */
function sameModel(requested: string, served: string): boolean {
  return (
    requested === served || requested.endsWith(`/${served}`) || served.endsWith(`/${requested}`)
  );
}

/** `/status`: where things are and why the current model behaves as it does. */
export function statusReport(
  ivy: Ivy,
  model: string,
  sessionId: string,
  sessionFile: string,
): string {
  const p = ivy.config.activeProvider;
  const prompt = ivy.systemPromptParts;
  const total = prompt.reduce((n, part) => n + part.text.length, 0);
  const plugins = ivy.plugins.list().map((plugin) => {
    const tools = plugin.tools?.length ?? 0;
    const commands = plugin.commands?.map((c) => c.name).join(" ") ?? "";
    const extras = [
      tools ? `${tools} tool${tools === 1 ? "" : "s"}` : "",
      plugin.contextFor ? "context" : "",
      commands,
    ].filter(Boolean);
    return `${plugin.id}${extras.length ? ` (${extras.join(", ")})` : ""}`;
  });
  const lines = [
    "Status",
    `  provider: ${p.name} · ${p.base_url}`,
    `  model: ${model}`,
    ...ivy.capabilities.explain(model).map((l) => `    ${l}`),
    `  system prompt: ${prompt.map((part) => `${part.name} ${part.text.length}`).join(" · ")} · total ${total} chars`,
    `  plugins: ${plugins.join(", ") || "none"}${ivy.plugins.disabled.length ? ` · disabled: ${ivy.plugins.disabled.join(", ")}` : ""}`,
    `  session: ${sessionId} · ${sessionFile}`,
    `  traces: ${ivy.config.trace.enabled ? `${ivy.paths.traces}/${sessionId}` : "off"}`,
    `  config: ${ivy.paths.config}`,
    `  capability cache: ${ivy.paths.home}/cache/models.json`,
  ];
  return lines.join("\n");
}
