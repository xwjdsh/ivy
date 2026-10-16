import type { AgentEvent, Ivy, RequestInfo } from "@ivy/kernel";

type StepEvent = Extract<AgentEvent, { type: "step" }>;

/**
 * "→ step 1 · 5 msgs · 1 tools · context block". Only what changes per step; model and
 * effort are in the status bar, capability details in /status.
 */
export function formatRequest(step: number, info: RequestInfo): string {
  const parts = [`→ step ${step}`, `${info.messages} msgs`, `${info.tools} tools`];
  if (info.hasContext) parts.push(`context ${info.contextMode}`);
  return parts.join(" · ");
}

/** "← step 1 · end_turn · in 120 out 30 · cache read 0 write 0 · 1.3s" (+ trace path) */
export function formatStep(e: StepEvent, requestedModel?: string): string {
  const u = e.usage;
  const parts = [
    `← step ${e.step}`,
    e.stopReason ?? "?",
    `in ${u.input_tokens} out ${u.output_tokens}`,
    `cache read ${u.cache_read_input_tokens ?? 0} write ${u.cache_creation_input_tokens ?? 0}`,
    `${(e.latencyMs / 1000).toFixed(1)}s`,
  ];
  if (requestedModel && !sameModel(requestedModel, e.model)) parts.push(`served by ${e.model}`);
  return parts.join(" · ") + (e.traceFile ? `\n  trace: ${e.traceFile}` : "");
}

/**
 * Proxies often report a model without its routing prefix ("qoder/qfmodel" → "qfmodel");
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
