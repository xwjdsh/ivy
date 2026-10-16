import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readRecords } from "./session.ts";

export interface UsageTotals {
  costUsd: number;
  /** Model calls (one per agent loop step). */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Sessions with at least one call in range. */
  sessions: number;
}

export interface UsageFilter {
  /** Only calls at or after this time. */
  since?: Date;
  /** Only this session. */
  sessionId?: string;
}

/** Sum the usage records stored in session files. */
export function summarizeUsage(sessionsDir: string, filter: UsageFilter = {}): UsageTotals {
  const totals: UsageTotals = {
    costUsd: 0,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    sessions: 0,
  };
  if (!existsSync(sessionsDir)) return totals;

  const since = filter.since?.toISOString();
  const files = filter.sessionId
    ? [`${filter.sessionId}.jsonl`]
    : readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));

  for (const name of files) {
    const file = join(sessionsDir, name);
    if (!existsSync(file)) continue;
    let counted = false;
    for (const record of readRecords(file)) {
      if (record.type !== "usage" || (since && record.ts < since)) continue;
      const u = record.usage;
      totals.costUsd += record.costUsd;
      totals.calls += 1;
      totals.inputTokens += u.input_tokens;
      totals.outputTokens += u.output_tokens;
      totals.cacheReadTokens += u.cache_read_input_tokens ?? 0;
      totals.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
      counted = true;
    }
    if (counted) totals.sessions += 1;
  }
  return totals;
}
