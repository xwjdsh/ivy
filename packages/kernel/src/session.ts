import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

type MessageParam = Anthropic.Beta.BetaMessageParam;

/** One line of a session JSONL file. */
export type SessionRecord =
  | { type: "meta"; id: string; createdAt: string; model: string }
  | { type: "message"; ts: string; message: MessageParam }
  | { type: "usage"; ts: string; usage: Anthropic.Beta.BetaUsage; costUsd: number };

export interface SessionSummary {
  id: string;
  file: string;
  createdAt: string;
  preview: string;
}

/**
 * An append-only conversation transcript. History is never rewritten:
 * this keeps prompt caching effective and replayed thinking blocks valid.
 */
export class Session {
  readonly messages: MessageParam[] = [];

  /** Meta record not yet written: the file is created lazily on the first append. */
  private pendingMeta: SessionRecord | null = null;

  private constructor(
    readonly id: string,
    readonly file: string,
  ) {}

  static create(dir: string, model: string): Session {
    const now = new Date();
    const id = `${now.toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
    const session = new Session(id, join(dir, `${id}.jsonl`));
    session.pendingMeta = { type: "meta", id, createdAt: now.toISOString(), model };
    return session;
  }

  static load(dir: string, id: string): Session {
    const file = join(dir, `${id}.jsonl`);
    if (!existsSync(file)) throw new Error(`Session not found: ${id}`);
    const session = new Session(id, file);
    for (const record of readRecords(file)) {
      if (record.type === "message") session.messages.push(record.message);
    }
    return session;
  }

  /** Most recent sessions first. */
  static list(dir: string, limit = 20): SessionSummary[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const file = join(dir, f);
        const records = readRecords(file);
        const meta = records.find((r) => r.type === "meta");
        const firstUser = records.find((r) => r.type === "message" && r.message.role === "user");
        return {
          id: f.replace(/\.jsonl$/, ""),
          file,
          createdAt: meta?.type === "meta" ? meta.createdAt : "",
          preview: firstUser?.type === "message" ? textOf(firstUser.message).slice(0, 80) : "",
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  append(...messages: MessageParam[]): void {
    for (const message of messages) {
      this.messages.push(message);
      this.write({ type: "message", ts: new Date().toISOString(), message });
    }
  }

  recordUsage(usage: Anthropic.Beta.BetaUsage, costUsd: number): void {
    this.write({ type: "usage", ts: new Date().toISOString(), usage, costUsd });
  }

  private write(record: SessionRecord): void {
    if (this.pendingMeta) {
      const meta = this.pendingMeta;
      this.pendingMeta = null;
      mkdirSync(dirname(this.file), { recursive: true });
      this.write(meta);
    }
    appendFileSync(this.file, `${JSON.stringify(record)}\n`);
  }
}

function readRecords(file: string): SessionRecord[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionRecord);
}

function textOf(message: MessageParam): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join(" ")
    .trim();
}
