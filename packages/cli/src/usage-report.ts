import { summarizeUsage, type UsageTotals } from "@ivy/kernel";

const DAY = 24 * 60 * 60 * 1000;

/** 1234 → "1.2k", 1234567 → "1.2M". */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Prompt tokens sent (incl. cache reads/writes), the cached part of them, and output tokens. */
export interface TokenCount {
  in: number;
  cached: number;
  out: number;
}

export const NO_TOKENS: TokenCount = { in: 0, cached: 0, out: 0 };

/** Token counts from a session's recorded totals. */
export function tokensFromTotals(u: UsageTotals): TokenCount {
  return {
    in: u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens,
    cached: u.cacheReadTokens,
    out: u.outputTokens,
  };
}

/** Token counts from one API response's usage. */
export function tokensFromUsage(u: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): TokenCount {
  const cached = u.cache_read_input_tokens ?? 0;
  return {
    in: u.input_tokens + cached + (u.cache_creation_input_tokens ?? 0),
    cached,
    out: u.output_tokens,
  };
}

export const addTokens = (a: TokenCount, b: TokenCount): TokenCount => ({
  in: a.in + b.in,
  cached: a.cached + b.cached,
  out: a.out + b.out,
});

/** "3.5k in (3.4k cached) / 32 out" */
export function formatTokens(t: TokenCount): string {
  const cached = t.cached > 0 ? ` (${compact(t.cached)} cached)` : "";
  return `${compact(t.in)} in${cached} / ${compact(t.out)} out`;
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
