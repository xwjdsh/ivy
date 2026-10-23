import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { ConversationHistory, PastMessage } from "@ivy/plugin-api";
import { imageTypeOf, isImageName } from "./images.ts";
import { promptText } from "./turn-context.ts";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlock = Exclude<MessageParam["content"], string>[number];

/**
 * An image as the session file holds it: its file in the session's image folder, not its
 * bytes (DESIGN.md §5.4). Read back into an image block when the session loads.
 */
interface StoredImage {
  type: "image";
  file: string;
}

/**
 * Where a reply came from: the endpoint (its `base_url`, see endpointKey) and the model. Its
 * thinking goes back only to that model there (DESIGN.md §5.2.1).
 */
export interface Origin {
  endpoint: string;
  model: string;
}

/** One line of a session JSONL file. */
export type SessionRecord =
  | { type: "meta"; id: string; createdAt: string; model: string }
  /**
   * `context`: the turn's plugin context, kept apart from what the user typed (see
   * turn-context.ts). `origin`: where a reply came from (none before it was recorded).
   */
  | { type: "message"; ts: string; message: MessageParam; context?: string; origin?: Origin }
  | { type: "usage"; ts: string; usage: Anthropic.Beta.BetaUsage; costUsd: number }
  /** The session read outside content here, from `tool`: tainted until the user's next prompt (DESIGN.md §8.1). */
  | { type: "outside"; ts: string; tool: string };

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
  /** Where each reply came from, keyed by message object. */
  private readonly origins = new Map<MessageParam, Origin>();
  /** The file of each image the user sent, keyed by block object. */
  private readonly images = new Map<ContentBlock, string>();
  /** The images sent in this session: a folder beside its file, of its name. */
  readonly imagesDir: string;

  /** Meta record not yet written: the file is created lazily on the first append. */
  private pendingMeta: SessionRecord | null = null;
  /** The file ends in a partial line (crash mid-write); start the next write on a new line. */
  private needsNewline = false;
  /** Outside content read since the user's last prompt. */
  private outside = false;

  private constructor(
    readonly id: string,
    readonly file: string,
  ) {
    this.imagesDir = join(dirname(file), id);
  }

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
      if (r.type === "outside") session.outside = true;
      if (r.type !== "message") return [];
      if (promptText(r.message) !== null) session.outside = false;
      const message = session.fromDisk(r.message);
      if (r.context) session.contexts.set(message, r.context);
      if (r.origin) session.origins.set(message, r.origin);
      return [message];
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

  /**
   * Append what the user typed, and the images sent with it (already in `imagesDir`), with
   * this turn's plugin context (if any) stored alongside.
   */
  appendPrompt(text: string, context: string, images: string[] = []): void {
    const message: MessageParam = {
      role: "user",
      content: images.length
        ? [
            ...images.map((f) => this.imageBlock(f)),
            ...(text ? [{ type: "text" as const, text }] : []),
          ]
        : text,
    };
    this.messages.push(message);
    // The user speaking again ends the taint: what Ivy writes next answers them.
    this.outside = false;
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

  originOf(message: MessageParam): Origin | undefined {
    return this.origins.get(message);
  }

  /** The file of an image the user sent, in `imagesDir`. */
  imageOf(block: ContentBlock): string | undefined {
    return this.images.get(block);
  }

  /** Messages passed together are written in one call, so a tool call and its results land together. */
  append(...messages: MessageParam[]): void {
    this.appendFrom(undefined, ...messages);
  }

  /** As `append`, with where the replies among them came from. */
  appendFrom(origin: Origin | undefined, ...messages: MessageParam[]): void {
    const ts = new Date().toISOString();
    this.messages.push(...messages);
    const records = messages.map((message): SessionRecord => {
      const from = message.role === "assistant" ? origin : undefined;
      if (from) this.origins.set(message, from);
      return { type: "message", ts, message, ...(from && { origin: from }) };
    });
    this.write(...records);
  }

  /** Whether the session read outside content since the user's last prompt (DESIGN.md §8.1). */
  get tainted(): boolean {
    return this.outside;
  }

  /** Record that the session read outside content, from `tool`; once a turn is enough. */
  markOutside(tool: string): void {
    if (this.outside) return;
    this.outside = true;
    this.write({ type: "outside", ts: new Date().toISOString(), tool });
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
    const lines = records.map((r) =>
      JSON.stringify(r.type === "message" ? { ...r, message: this.toDisk(r.message) } : r),
    );
    appendFileSync(this.file, prefix + lines.map((l) => `${l}\n`).join(""));
  }

  /** An image the user sent, as a block for the model, from its file. */
  private imageBlock(file: string): ContentBlock {
    const path = join(this.imagesDir, file);
    if (!isImageName(file) || !existsSync(path)) {
      return { type: "text", text: "[An image that is no longer on disk]" };
    }
    const block: ContentBlock = {
      type: "image",
      source: {
        type: "base64",
        media_type: imageTypeOf(file),
        data: readFileSync(path).toString("base64"),
      },
    };
    this.images.set(block, file);
    return block;
  }

  /** A message as the file holds it: its images by file name. */
  private toDisk(message: MessageParam): MessageParam {
    if (typeof message.content === "string" || !message.content.some((b) => this.images.has(b))) {
      return message;
    }
    const content = message.content.map((b) => {
      const file = this.images.get(b);
      return file ? ({ type: "image", file } satisfies StoredImage as unknown as ContentBlock) : b;
    });
    return { ...message, content };
  }

  /** A message from the file: its images read back. */
  private fromDisk(message: MessageParam): MessageParam {
    if (typeof message.content === "string") return message;
    const stored = (b: unknown): b is StoredImage =>
      (b as StoredImage).type === "image" && typeof (b as StoredImage).file === "string";
    if (!message.content.some(stored)) return message;
    const content = message.content.map((b) => (stored(b) ? this.imageBlock(b.file) : b));
    return { ...message, content };
  }
}

/** The folder, inside the sessions folder, that deleted sessions are moved to. */
const TRASH = "trash";

/**
 * Move a session's file (and its images) to the trash folder inside the sessions folder, out of every list
 * and out of plugins' history, but not gone: moving it back restores it. False if it has
 * no file (never written, or unknown).
 */
export function trashSession(dir: string, id: string): boolean {
  const file = join(dir, `${id}.jsonl`);
  if (!isSessionId(id) || !existsSync(file)) return false;
  mkdirSync(join(dir, TRASH), { recursive: true });
  renameSync(file, join(dir, TRASH, `${id}.jsonl`));
  // Its images go with it.
  if (existsSync(join(dir, id))) renameSync(join(dir, id), join(dir, TRASH, id));
  return true;
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
 * Keep tool calls and their results in pairs, as the API requires: drop an assistant message
 * whose tool calls never got results (a crash between the two writes), and results whose
 * call is gone (its line skipped as corrupt), which would otherwise fail every later request.
 */
function withoutDanglingToolUse(messages: MessageParam[]): MessageParam[] {
  const callIds = (m: MessageParam | undefined) =>
    m?.role === "assistant" && typeof m.content !== "string"
      ? m.content.flatMap((b) => (b.type === "tool_use" ? [b.id] : []))
      : [];
  const resultIds = (m: MessageParam | undefined) =>
    m?.role === "user" && typeof m.content !== "string"
      ? m.content.flatMap((b) => (b.type === "tool_result" ? [b.tool_use_id] : []))
      : [];
  const answered = messages.filter((m, i) => {
    const ids = callIds(m);
    const results = new Set(resultIds(messages[i + 1]));
    return ids.every((id) => results.has(id));
  });
  return answered.filter((m, i) => {
    const results = resultIds(m);
    if (results.length === 0) return true;
    const calls = new Set(callIds(answered[i - 1]));
    return results.every((id) => calls.has(id));
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
      let outside = false;
      return readRecords(file).flatMap((r): PastMessage[] => {
        if (r.type === "outside") outside = true;
        if (r.type !== "message" || r.message.role === "system") return [];
        if (promptText(r.message) !== null) outside = false;
        const { role } = r.message;
        const text = role === "user" ? promptText(r.message) : assistantText(r.message);
        if (!text) return [];
        return [{ role, text, ts: r.ts, ...(outside && role === "assistant" && { outside }) }];
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
