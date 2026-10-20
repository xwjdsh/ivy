// Reports the daemon lays out for clients (/usage, /status), as text for a terminal.

import { type Ivy, type PromptPart, summarizeUsage, type UsageTotals } from "@ivy/kernel";
import { compact } from "@ivy/protocol";

const DAY = 24 * 60 * 60 * 1000;

function row(label: string, t: UsageTotals, showSessions: boolean): string {
  const parts = [
    `${t.calls} calls`.padEnd(10),
    (showSessions ? `${t.sessions} sessions` : "").padEnd(12),
    `in ${compact(t.input)}`,
    `out ${compact(t.output)}`,
    `cache read ${compact(t.cacheRead)} / write ${compact(t.cacheWrite)}`,
  ];
  return `  ${label.padEnd(15)}${parts.join("  ")}`;
}

/** The `/usage` report: this session, today, last 7 days, all time. */
export function usageReport(sessionsDir: string, sessionId: string, now = new Date()): string {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return [
    "Token usage",
    row("This session", summarizeUsage(sessionsDir, { sessionId }), false),
    row("Today", summarizeUsage(sessionsDir, { since: startOfToday }), true),
    row(
      "Last 7 days",
      summarizeUsage(sessionsDir, { since: new Date(now.getTime() - 7 * DAY) }),
      true,
    ),
    row("All time", summarizeUsage(sessionsDir), true),
  ].join("\n");
}

/** `/status`: where things are and why the current model behaves as it does. */
export function statusReport(
  ivy: Ivy,
  model: string,
  sessionId: string,
  sessionFile: string,
  prompt: PromptPart[],
): string {
  const ref = ivy.agent.modelRef;
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
    `  model: ${model}`,
    `  provider: ${ref.provider.name} · ${ref.provider.base_url}`,
    ...ivy.capabilities.explain(ref).map((l) => `    ${l}`),
    `  system prompt: ${prompt.map((part) => `${part.name} ${part.text.length}`).join(" · ")} · total ${total} chars`,
    `  tools: ${
      ivy.plugins
        .toolList()
        .map((t) => `${t.name} (${t.risk}${t.defaultAllow ? ", allowed by plugin" : ""})`)
        .join(", ") || "none"
    }`,
    `  permissions: ${permissionSummary(ivy)}`,
    `  plugins: ${plugins.join(", ") || "none"}${ivy.plugins.disabled.length ? ` · disabled: ${ivy.plugins.disabled.join(", ")}` : ""}`,
    `  session: ${sessionId} · ${sessionFile}`,
    `  traces: ${ivy.config.trace.enabled ? `${ivy.paths.traces}/${sessionId}` : "off"}`,
    `  config: ${ivy.paths.config}`,
    `  capability cache: ${ivy.paths.modelsCache}`,
  ];
  return lines.join("\n");
}

function permissionSummary(ivy: Ivy): string {
  const p = ivy.permissions.summary();
  const parts = [
    p.deny.length ? `deny ${p.deny.join(" ")}` : "",
    p.ask.length ? `ask ${p.ask.join(" ")}` : "",
    p.allow.length ? `allow ${p.allow.join(" ")}` : "",
  ].filter(Boolean);
  return parts.join(" · ") || "defaults only";
}
