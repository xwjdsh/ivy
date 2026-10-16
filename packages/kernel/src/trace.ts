import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelMessage, ModelRequest } from "./model.ts";

export interface TraceEntry {
  request: ModelRequest;
  response?: ModelMessage;
  error?: string;
  startedAt: string;
  latencyMs: number;
}

/** Writes every model call verbatim to ~/.ivy/traces/<session>/<n>.json for debugging. */
export class Tracer {
  private seq = 0;

  constructor(private readonly dir: string) {}

  record(entry: TraceEntry): string {
    mkdirSync(this.dir, { recursive: true });
    const name = `${entry.startedAt.replace(/[:.]/g, "-")}-${String(++this.seq).padStart(3, "0")}.json`;
    const file = join(this.dir, name);
    writeFileSync(file, JSON.stringify(entry, null, 2));
    return file;
  }
}

/**
 * Delete per-session trace folders not written to for `days` days. Each trace holds
 * the full request (whole history), so traces grow fast and are worth pruning.
 */
export function pruneTraces(dir: string, days: number, now = Date.now()): number {
  if (days <= 0 || !existsSync(dir)) return 0;
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory() && stat.mtimeMs < cutoff) {
      rmSync(path, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}
