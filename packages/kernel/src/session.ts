import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { ConversationHistory, PastMessage, SessionPoints } from "@ivy/plugin-api";
import { imageTypeOf, isImageName } from "./images.ts";
import { contextBlock, promptText } from "./turn-context.ts";

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
  | {
      type: "meta";
      id: string;
      createdAt: string;
      model: string;
      /**
       * Off the record (docs/design/companion.md#off-the-record-and-taken-back): nothing reads it,
       * and it is deleted once let go.
       */
      offRecord?: true;
      /** Started by Ivy, writing first (docs/design/companion.md#ivy-writes-first). */
      fromIvy?: true;
    }
  /**
   * `context`: the turn's plugin context, kept apart from what the user typed (see
   * turn-context.ts). `origin`: where a reply came from (none before it was recorded).
   */
  | { type: "message"; ts: string; message: MessageParam; context?: string; origin?: Origin }
  | { type: "usage"; ts: string; usage: Anthropic.Beta.BetaUsage; costUsd: number }
  /**
   * The session read outside content here, from `tool`: tainted until the user's next prompt
   * (docs/design/security.md#outside-content).
   */
  | { type: "outside"; ts: string; tool: string; ids?: string[] }
  /**
   * What was said from the user's `prompt`th message (from 1) to the end of the turn this
   * line is in was taken back (her reply to it may say what it was): nothing reads it later.
   * By place, not time: lines written in one instant tie.
   */
  | { type: "taken_back"; ts: string; prompt: number };

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
  offRecord?: true;
  fromIvy?: true;
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
  /** Off the record: nothing reads it, its own records are closed to it, it goes when let go. */
  offRecord = false;
  /** The file ends in a partial line (crash mid-write); start the next write on a new line. */
  private needsNewline = false;
  /** Outside content read since the user's last prompt. */
  private outside = false;
  /** The tool calls whose results were outside content, by id: where Ivy's words came from. */
  private readonly outsideResults = new Set<string>();

  private constructor(
    readonly id: string,
    readonly file: string,
  ) {
    this.imagesDir = join(dirname(file), id);
  }

  static create(
    dir: string,
    model: string,
    options: { offRecord?: boolean; fromIvy?: boolean } = {},
  ): Session {
    const now = new Date();
    const id = `${now.toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
    const session = new Session(id, join(dir, `${id}.jsonl`));
    session.offRecord = options.offRecord === true;
    session.pendingMeta = {
      type: "meta",
      id,
      createdAt: now.toISOString(),
      model,
      ...(session.offRecord && { offRecord: true as const }),
      ...(options.fromIvy && { fromIvy: true as const }),
    };
    return session;
  }

  static load(dir: string, id: string): Session {
    const file = join(dir, `${id}.jsonl`);
    if (!isSessionId(id) || !existsSync(file)) throw new Error(`Session not found: ${id}`);
    const session = new Session(id, file);
    const content = readFileSync(file, "utf8");
    session.needsNewline = content.length > 0 && !content.endsWith("\n");
    const messages = parseRecords(content).flatMap((r) => {
      if (r.type === "meta" && r.offRecord) session.offRecord = true;
      if (r.type === "outside") {
        session.outside = true;
        for (const id of r.ids ?? []) session.outsideResults.add(id);
      }
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

  /** Whether a session on disk is off the record, from its first line. */
  static isOffRecord(dir: string, id: string): boolean {
    const file = join(dir, `${id}.jsonl`);
    if (!isSessionId(id) || !existsSync(file)) return false;
    const meta = readRecords(file).find((r) => r.type === "meta");
    return meta?.type === "meta" && meta.offRecord === true;
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
        // What was taken back isn't shown in the list either.
        const takenBack = takenBackAt(records);
        const prompts = records.flatMap((r, at) => {
          const text = r.type === "message" ? promptText(r.message) : null;
          return text === null || takenBack(at) ? [] : [text];
        });
        const last = records.at(-1);
        const createdAt = meta?.type === "meta" ? meta.createdAt : "";
        return {
          id: f.replace(/\.jsonl$/, ""),
          file,
          createdAt,
          updatedAt: last && last.type !== "meta" ? last.ts : createdAt,
          turns: prompts.length,
          // One she started has her words first, until the user says something.
          preview: (prompts[0] ?? openingOf(records) ?? "").slice(0, 80),
          ...(meta?.type === "meta" && meta.offRecord && { offRecord: true as const }),
          ...(meta?.type === "meta" && meta.fromIvy && { fromIvy: true as const }),
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

  /**
   * Begin a conversation with her message (docs/design/companion.md#ivy-writes-first). The API
   * wants a user turn first: a context block saying she wrote first, which is no prompt of the
   * user's.
   */
  appendOpening(text: string, note: string): void {
    const opener: MessageParam = {
      role: "user",
      content: [{ type: "text", text: contextBlock([{ id: "conversation", text: note }]) }],
    };
    const reply: MessageParam = { role: "assistant", content: [{ type: "text", text }] };
    this.messages.push(opener, reply);
    const ts = new Date().toISOString();
    this.write({ type: "message", ts, message: opener }, { type: "message", ts, message: reply });
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

  /**
   * Whether the session read outside content since the user's last prompt
   * (docs/design/security.md#outside-content).
   */
  get tainted(): boolean {
    return this.outside;
  }

  /**
   * Record that the session read outside content, from `tool`, in the results of the calls
   * `ids`: the turn is tainted (once a turn is enough), and those results are where Ivy's words
   * came from.
   */
  markOutside(tool: string, ids: string[] = []): void {
    if (this.outside && ids.length === 0) return;
    this.outside = true;
    for (const id of ids) this.outsideResults.add(id);
    this.write({ type: "outside", ts: new Date().toISOString(), tool, ...(ids.length && { ids }) });
  }

  /**
   * The part of this conversation from the user's message `from` matches (a piece of exactly
   * one of theirs), with the tool calls made since, by full name; or the messages it could
   * mean, when it doesn't match exactly one.
   */
  spanFrom(
    from: string,
  ):
    | { candidates: string[] }
    | { prompt: number; calls: Array<{ name: string; input: unknown; result: string }> } {
    const records = existsSync(this.file) ? readRecords(this.file) : [];
    const said = records.flatMap((r, at) => {
      const text = r.type === "message" ? promptText(r.message) : null;
      return text === null ? [] : [{ at, text }];
    });
    // Not the message asking: it often quotes what it takes back.
    const hits = said
      .slice(0, -1)
      .flatMap((m, i) =>
        from.trim() && m.text.includes(from.trim()) ? [{ ...m, prompt: i + 1 }] : [],
      );
    const hit = hits.length === 1 ? hits[0] : undefined;
    if (!hit) return { candidates: (hits.length ? hits : said.slice(0, -1)).map((m) => m.text) };
    const asked = new Map<string, { name: string; input: unknown }>();
    const calls: Array<{ name: string; input: unknown; result: string }> = [];
    for (const r of records.slice(hit.at)) {
      if (r.type !== "message" || typeof r.message.content === "string") continue;
      for (const b of r.message.content) {
        if (b.type === "tool_use") asked.set(b.id, { name: b.name, input: b.input });
        if (b.type === "tool_result") {
          const call = asked.get(b.tool_use_id);
          const content = b.content;
          const result =
            typeof content === "string"
              ? content
              : (content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
          if (call) calls.push({ ...call, result });
        }
      }
    }
    return { prompt: hit.prompt, calls };
  }

  /** Mark what was said from the user's `prompt`th message until now as taken back. */
  takeBack(prompt: number): void {
    this.write({ type: "taken_back", ts: new Date().toISOString(), prompt });
  }

  /** Whether a tool call's result was outside content. */
  readOutside(toolUseId: string): boolean {
    return this.outsideResults.has(toolUseId);
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
  // Its images and key points go with it.
  if (existsSync(join(dir, id))) renameSync(join(dir, id), join(dir, TRASH, id));
  const points = pointsFile(dir, id);
  if (existsSync(points)) renameSync(points, join(dir, TRASH, `${id}.points.json`));
  return true;
}

/** Her first words in a conversation she started, before the user said anything. */
function openingOf(records: SessionRecord[]): string | undefined {
  for (const r of records) {
    if (r.type !== "message") continue;
    if (r.message.role === "user" && promptText(r.message) !== null) return undefined;
    if (r.message.role === "assistant") return assistantText(r.message) ?? undefined;
  }
  return undefined;
}

/**
 * Whether the record at a place lies in a part the user took back: from the nth message of
 * theirs a `taken_back` line names to the end of the turn holding it (their next message).
 */
function takenBackAt(records: SessionRecord[]): (at: number) => boolean {
  const prompts = records.flatMap((r, at) =>
    r.type === "message" && promptText(r.message) !== null ? [at] : [],
  );
  const spans = records.flatMap((r, at) => {
    if (r.type !== "taken_back") return [];
    const end = prompts.find((p) => p > at) ?? records.length;
    return [[prompts[r.prompt - 1] ?? at, end] as const];
  });
  return (at) => spans.some(([from, to]) => at >= from && at < to);
}

/**
 * Delete a session for good, with its images and key points: an off-the-record one, once let go
 * (docs/design/companion.md#off-the-record-and-taken-back). Not to the trash, which can be
 * restored. Its traces are the caller's (they live outside the sessions folder).
 */
export function removeSession(dir: string, id: string): boolean {
  const file = join(dir, `${id}.jsonl`);
  if (!isSessionId(id) || !existsSync(file)) return false;
  rmSync(file, { force: true });
  rmSync(join(dir, id), { recursive: true, force: true });
  rmSync(pointsFile(dir, id), { force: true });
  return true;
}

/**
 * A session's key points (points.ts): a file beside its transcript, so the transcript stays
 * written by its Session alone and its time stays that of the last activity.
 */
export function pointsFile(dir: string, id: string): string {
  return join(dir, `${id}.points.json`);
}

/** Keep a session's key points, replacing the last; written whole, then moved into place. */
export function savePoints(dir: string, id: string, points: SessionPoints): void {
  if (!isSessionId(id) || !existsSync(join(dir, `${id}.jsonl`))) return;
  const file = pointsFile(dir, id);
  writeFileSync(`${file}.new`, `${JSON.stringify(points, null, 2)}\n`);
  renameSync(`${file}.new`, file);
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
  // Read again only once a file changed: each turn's recall reads every past conversation.
  type Read = { mtimeMs: number; size: number; messages: PastMessage[]; offRecord: boolean };
  const read = new Map<string, Read>();
  /**
   * A session as plugins may read it. One off the record reads as nothing at all: every reader of
   * past conversations (key points, recall, the day's pass and notes, search) comes through here,
   * so none needs to know (docs/design/companion.md#off-the-record-and-taken-back).
   */
  const readSession = (sessionId: string): Read | undefined => {
    const file = join(dir, `${sessionId}.jsonl`);
    if (!isSessionId(sessionId) || !existsSync(file)) return undefined;
    const { mtimeMs, size } = statSync(file);
    const known = read.get(sessionId);
    if (known && known.mtimeMs === mtimeMs && known.size === size) return known;
    let outside = false;
    let offRecord = false;
    const records = readRecords(file);
    const takenBack = takenBackAt(records);
    const messages = records.flatMap((r, at): PastMessage[] => {
      if (r.type === "meta" && r.offRecord) offRecord = true;
      if (r.type === "outside") outside = true;
      if (r.type !== "message" || r.message.role === "system") return [];
      if (promptText(r.message) !== null) outside = false;
      const { role } = r.message;
      const text = role === "user" ? promptText(r.message) : assistantText(r.message);
      if (!text || takenBack(at)) return [];
      return [{ role, text, ts: r.ts, ...(outside && role === "assistant" && { outside }) }];
    });
    const fresh = { mtimeMs, size, messages: offRecord ? [] : messages, offRecord };
    read.set(sessionId, fresh);
    return fresh;
  };
  const history: ConversationHistory = {
    sessions() {
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .flatMap((f) => {
          const id = f.replace(/\.jsonl$/, "");
          const known = readSession(id);
          if (!known || known.offRecord) return [];
          // When the last thing was said, as Session.list has it: a file's time changes
          // when it is copied or backed up.
          const last = known.messages.at(-1)?.ts;
          return [{ id, updatedAt: last ?? statSync(join(dir, f)).mtime.toISOString() }];
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    messages(sessionId) {
      return readSession(sessionId)?.messages ?? [];
    },
    points(sessionId) {
      const file = pointsFile(dir, sessionId);
      if (!isSessionId(sessionId) || !existsSync(file)) return undefined;
      if (readSession(sessionId)?.offRecord) return undefined;
      try {
        const p = JSON.parse(readFileSync(file, "utf8")) as SessionPoints;
        // A file edited by hand or damaged is no points, rather than a failing reader.
        const lines = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
        const sound =
          typeof p.title === "string" &&
          lines(p.points) &&
          lines(p.open) &&
          typeof p.through === "string";
        return sound ? p : undefined;
      } catch {
        return undefined;
      }
    },
  };
  return history;
}

function assistantText(message: MessageParam): string | null {
  if (typeof message.content === "string") return message.content.trim() || null;
  const text = message.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("\n")
    .trim();
  return text || null;
}
