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
  /** Time of the last record: when the session was last active. */
  updatedAt: string;
  /** Number of user prompts (tool results don't count). */
  turns: number;
  /** Start of the first user prompt. */
  preview: string;
}

/**
 * An append-only conversation transcript. History is never rewritten:
 * this keeps prompt caching effective and replayed thinking blocks valid.
 */
export class Session {
  readonly messages: MessageParam[] = [];
  /** Total estimated cost of all model calls in this session. */
  costUsd = 0;

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
      if (record.type === "usage") session.costUsd += record.costUsd;
    }
    return session;
  }

  /** Most recently active sessions first. */
  static list(dir: string, limit = 20): SessionSummary[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const file = join(dir, f);
        const records = readRecords(file);
        const meta = records.find((r) => r.type === "meta");
        const prompts = records.filter(
          (r) =>
            r.type === "message" &&
            r.message.role === "user" &&
            typeof r.message.content === "string",
        );
        const first = prompts[0];
        const last = records.at(-1);
        const createdAt = meta?.type === "meta" ? meta.createdAt : "";
        return {
          id: f.replace(/\.jsonl$/, ""),
          file,
          createdAt,
          updatedAt: last && last.type !== "meta" ? last.ts : createdAt,
          turns: prompts.length,
          preview: first?.type === "message" ? textOf(first.message).slice(0, 80) : "",
        };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  append(...messages: MessageParam[]): void {
    for (const message of messages) {
      this.messages.push(message);
      this.write({ type: "message", ts: new Date().toISOString(), message });
    }
  }

  recordUsage(usage: Anthropic.Beta.BetaUsage, costUsd: number): void {
    this.costUsd += costUsd;
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
