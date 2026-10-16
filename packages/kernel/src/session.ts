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

  /** Meta record not yet written: the file is created lazily on the first append. */
  private pendingMeta: SessionRecord | null = null;
  /** The file ends in a partial line (crash mid-write); start the next write on a new line. */
  private needsNewline = false;

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
    const content = readFileSync(file, "utf8");
    session.needsNewline = content.length > 0 && !content.endsWith("\n");
    const messages = parseRecords(content).flatMap((r) =>
      r.type === "message" ? [r.message] : [],
    );
    session.messages.push(...withoutDanglingToolUse(messages));
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

  /** Messages passed together are written in one call, so a tool call and its results land together. */
  append(...messages: MessageParam[]): void {
    const ts = new Date().toISOString();
    this.messages.push(...messages);
    this.write(...messages.map((message): SessionRecord => ({ type: "message", ts, message })));
  }

  recordUsage(usage: Anthropic.Beta.BetaUsage, costUsd: number): void {
    this.write({ type: "usage", ts: new Date().toISOString(), usage, costUsd });
  }

  private write(...records: SessionRecord[]): void {
    if (this.pendingMeta) {
      records.unshift(this.pendingMeta);
      this.pendingMeta = null;
      mkdirSync(dirname(this.file), { recursive: true });
    }
    const prefix = this.needsNewline ? "\n" : "";
    this.needsNewline = false;
    appendFileSync(this.file, prefix + records.map((r) => `${JSON.stringify(r)}\n`).join(""));
  }
}

export function readRecords(file: string): SessionRecord[] {
  return parseRecords(readFileSync(file, "utf8"));
}

/** Parse JSONL, skipping lines that aren't valid JSON (e.g. a write cut off by a crash). */
function parseRecords(content: string): SessionRecord[] {
  return content.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as SessionRecord];
    } catch {
      return [];
    }
  });
}

/**
 * Drop assistant messages whose tool calls never got results (a crash between
 * the two writes, or a skipped corrupt line). The API rejects such histories.
 */
function withoutDanglingToolUse(messages: MessageParam[]): MessageParam[] {
  return messages.filter((m, i) => {
    if (m.role !== "assistant" || typeof m.content === "string") return true;
    const ids = m.content.flatMap((b) => (b.type === "tool_use" ? [b.id] : []));
    if (ids.length === 0) return true;
    const next = messages[i + 1];
    const answered = new Set(
      next?.role === "user" && typeof next.content !== "string"
        ? next.content.flatMap((b) => (b.type === "tool_result" ? [b.tool_use_id] : []))
        : [],
    );
    return ids.every((id) => answered.has(id));
  });
}

function textOf(message: MessageParam): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join(" ")
    .trim();
}
