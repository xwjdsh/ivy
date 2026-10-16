import type { AgentEvent, Ivy, RequestInfo } from "@ivy/kernel";

type StepEvent = Extract<AgentEvent, { type: "step" }>;

/** "→ step 1 · qoder/qfmodel · effort high→high · context block · 5 msgs · 1 tools · max 64000" */
export function formatRequest(step: number, info: RequestInfo): string {
  const effort =
    info.effort.sent === undefined
      ? `effort ${info.effort.configured} (not sent)`
      : info.effort.sent === info.effort.configured
        ? `effort ${info.effort.sent}`
        : `effort ${info.effort.configured}→${info.effort.sent}`;
  const parts = [
    `→ step ${step}`,
    info.model,
    effort,
    `context ${info.contextMode}`,
    `${info.messages} msgs`,
    `${info.tools} tools`,
    `max_tokens ${info.maxTokens}`,
  ];
  if (info.betas.length > 0) parts.push(`betas ${info.betas.join(",")}`);
  return parts.join(" · ");
}

/** "← step 1 · end_turn · in 120 out 30 · cache read 0 write 0 · $0.0012 · 1.3s" (+ trace path) */
export function formatStep(e: StepEvent, requestedModel?: string): string {
  const u = e.usage;
  const parts = [
    `← step ${e.step}`,
    e.stopReason ?? "?",
    `in ${u.input_tokens} out ${u.output_tokens}`,
    `cache read ${u.cache_read_input_tokens ?? 0} write ${u.cache_creation_input_tokens ?? 0}`,
    e.costUsd === null ? "$?" : `$${e.costUsd.toFixed(4)}`,
    `${(e.latencyMs / 1000).toFixed(1)}s`,
  ];
  if (requestedModel && e.model !== requestedModel) parts.push(`served by ${e.model}`);
  return parts.join(" · ") + (e.traceFile ? `\n  trace: ${e.traceFile}` : "");
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
