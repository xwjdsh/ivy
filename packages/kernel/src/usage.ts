import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { readRecords } from "./session.ts";

/** Tokens of model calls, as the API counts them: input excludes cache reads and writes. */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One response's usage as TokenCounts. */
export function tokenCounts(u: Anthropic.Beta.BetaUsage): TokenCounts {
  return {
    input: u.input_tokens,
    output: u.output_tokens,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  };
}

export interface UsageTotals extends TokenCounts {
  costUsd: number;
  /** Model calls (one per agent loop step). */
  calls: number;
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
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
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
      const u = tokenCounts(record.usage);
      totals.costUsd += record.costUsd;
      totals.calls += 1;
      totals.input += u.input;
      totals.output += u.output;
      totals.cacheRead += u.cacheRead;
      totals.cacheWrite += u.cacheWrite;
      counted = true;
    }
    if (counted) totals.sessions += 1;
  }
  return totals;
}

/**
 * The whole prompt of a session's last model call, cache included: how much of the model's
 * context the conversation fills now, and what each of its turns sends again.
 */
export function lastPrompt(sessionsDir: string, sessionId: string): number {
  const file = join(sessionsDir, `${sessionId}.jsonl`);
  if (!existsSync(file)) return 0;
  let last = 0;
  for (const record of readRecords(file)) {
    if (record.type !== "usage") continue;
    const u = tokenCounts(record.usage);
    last = u.input + u.cacheRead + u.cacheWrite;
  }
  return last;
}
