import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { ConversationHistory, PastMessage } from "@ivy/plugin-api";
import { promptText } from "./turn-context.ts";

type MessageParam = Anthropic.Beta.BetaMessageParam;

/** One line of a session JSONL file. */
export type SessionRecord =
  | { type: "meta"; id: string; createdAt: string; model: string }
  /** `context`: the turn's plugin context, kept apart from what the user typed (see turn-context.ts). */
  | { type: "message"; ts: string; message: MessageParam; context?: string }
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
  /** Plugin context attached to user prompts, keyed by message object. */
  private readonly contexts = new Map<MessageParam, string>();

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
    if (!isSessionId(id) || !existsSync(file)) throw new Error(`Session not found: ${id}`);
    const session = new Session(id, file);
    const content = readFileSync(file, "utf8");
    session.needsNewline = content.length > 0 && !content.endsWith("\n");
    const messages = parseRecords(content).flatMap((r) => {
      if (r.type !== "message") return [];
      if (r.context) session.contexts.set(r.message, r.context);
      return [r.message];
    });
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
        const prompts = records.flatMap((r) => {
          const text = r.type === "message" ? promptText(r.message) : null;
          return text === null ? [] : [text];
        });
        const last = records.at(-1);
        const createdAt = meta?.type === "meta" ? meta.createdAt : "";
        return {
          id: f.replace(/\.jsonl$/, ""),
          file,
          createdAt,
          updatedAt: last && last.type !== "meta" ? last.ts : createdAt,
          turns: prompts.length,
          preview: (prompts[0] ?? "").slice(0, 80),
        };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  /** Append what the user typed, with this turn's plugin context (if any) stored alongside. */
  appendPrompt(text: string, context: string): void {
    const message: MessageParam = { role: "user", content: text };
    this.messages.push(message);
    if (context) this.contexts.set(message, context);
    this.write({
      type: "message",
      ts: new Date().toISOString(),
      message,
      ...(context && { context }),
    });
  }

  contextOf(message: MessageParam): string | undefined {
    return this.contexts.get(message);
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

/** A session id names a file in the sessions folder, so it may not reach outside it. */
export function isSessionId(id: string): boolean {
  return /^[\w-]+$/.test(id);
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

/**
 * Past conversations for plugins: what the user typed and what Ivy answered, read from
 * the session files on each call. Tool traffic, thinking and per-turn context are left out.
 */
export function sessionHistory(dir: string): ConversationHistory {
  return {
    sessions() {
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => ({
          id: f.replace(/\.jsonl$/, ""),
          updatedAt: statSync(join(dir, f)).mtime.toISOString(),
        }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    messages(sessionId) {
      const file = join(dir, `${sessionId}.jsonl`);
      if (!isSessionId(sessionId) || !existsSync(file)) return [];
      return readRecords(file).flatMap((r): PastMessage[] => {
        if (r.type !== "message" || r.message.role === "system") return [];
        const { role } = r.message;
        const text = role === "user" ? promptText(r.message) : assistantText(r.message);
        return text ? [{ role, text, ts: r.ts }] : [];
      });
    },
  };
}

function assistantText(message: MessageParam): string | null {
  if (typeof message.content === "string") return message.content.trim() || null;
  const text = message.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("\n")
    .trim();
  return text || null;
}
