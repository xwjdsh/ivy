import { summarizeUsage, type UsageTotals } from "@ivy/kernel";

const DAY = 24 * 60 * 60 * 1000;

/** 1234 → "1.2k", 1234567 → "1.2M". */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function row(label: string, t: UsageTotals, showSessions: boolean): string {
  const parts = [
    `${t.calls} calls`.padEnd(10),
    (showSessions ? `${t.sessions} sessions` : "").padEnd(12),
    `in ${compact(t.inputTokens)}`,
    `out ${compact(t.outputTokens)}`,
    `cache read ${compact(t.cacheReadTokens)} / write ${compact(t.cacheWriteTokens)}`,
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
