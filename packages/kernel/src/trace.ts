import { mkdirSync, writeFileSync } from "node:fs";
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
