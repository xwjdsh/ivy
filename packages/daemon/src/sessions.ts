// Sessions in the daemon (DESIGN.md §5.7). Each has one inbox: a message that arrives while
// a turn runs waits for it, then runs as the next turn, whichever client sent it. What
// happens goes out as events to every client, so several can follow one session; any of
// them may answer a permission prompt, and the first answer counts.
//
// A session is loaded when a client first asks for it and let go once it has been idle a
// while, so a daemon that runs for weeks doesn't keep every session it ever opened.

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentEvent,
  claimUploads,
  errorMessage,
  type Ivy,
  isImageName,
  isSessionId,
  type PermissionChoice,
  promptText,
  Session,
  summarizeUsage,
  type ToolCallRequest,
  type Tracer,
  tokenCounts,
  trashSession,
} from "@ivy/kernel";
import {
  type Display,
  type Entry,
  PERMISSION_ANSWERS,
  type PermissionAsk,
  type Prompt,
  type SessionEvent,
  type SessionSummary,
  type SessionView,
  type TurnEnd,
  tokensFromUsage,
} from "@ivy/protocol";
import { DISPLAY_INSTRUCTIONS } from "./display.ts";

/** A permission prompt no client answers is refused after this long. */
export const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * A session no one has touched for this long, with nothing running or waiting, is let go;
 * it is loaded again when asked for, with its system prompt built afresh (the prompt
 * cache has expired by then anyway).
 */
export const IDLE_MS = 30 * 60 * 1000;
/** How often idle sessions are looked for. */
const SWEEP_MS = 60 * 1000;
/** On shutdown, how long running turns get to stop and write what they have. */
const CLOSE_WAIT_MS = 5000;

export interface SessionsOptions {
  ivy: Ivy;
  publish(event: SessionEvent): void;
  permissionTimeoutMs?: number;
  /** The clock (tests). */
  now?: () => number;
}

/** A session the daemon holds: loaded, or started here. */
interface Live {
  session: Session;
  tracer?: Tracer;
  /** When a client last asked for it, by the clock. */
  touched: number;
  /** Running the waiting messages; set while there are any, cleared once none are left. */
  pumping?: Promise<void>;
  queue: Prompt[];
  running?: {
    prompt: Prompt;
    controller: AbortController;
    /** The session's messages before this turn: what `entries` already covers. */
    before: number;
    /** The turn so far, as clients show it. */
    entries: Entry[];
    /** The last entry is assistant text still streaming. */
    open: boolean;
  };
}

interface PendingAsk {
  ask: PermissionAsk;
  resolve(choice: PermissionChoice): void;
}

export class SessionNotFoundError extends Error {}
/** A message that can't be taken as it is (an image no longer there). */
export class PromptError extends Error {}

export class Sessions {
  private readonly live = new Map<string, Live>();
  private readonly asks = new Map<string, PendingAsk>();
  /**
   * How sessions started here show replies, where it isn't the default (markdown), so one
   * let go and loaded again keeps its instructions. Until the daemon stops.
   */
  private readonly displays = new Map<string, Display>();
  private readonly ivy: Ivy;
  private readonly publish: (event: SessionEvent) => void;
  private readonly permissionTimeoutMs: number;
  private readonly now: () => number;
  private readonly sweeper: Timer;
  private closed = false;

  constructor(opts: SessionsOptions) {
    this.ivy = opts.ivy;
    this.publish = opts.publish;
    this.permissionTimeoutMs = opts.permissionTimeoutMs ?? PERMISSION_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
    this.sweeper = setInterval(() => this.sweep(), SWEEP_MS);
    this.sweeper.unref(); // the server keeps the daemon running, not this
  }

  /** Sessions on disk, most recently active first, with whether a turn runs in each. */
  list(limit = 50): SessionSummary[] {
    return Session.list(this.ivy.paths.sessions, limit).map(({ file: _, ...s }) => ({
      ...s,
      busy: this.live.get(s.id)?.running !== undefined,
    }));
  }

  /** Start a session. Its file is written with the first message. */
  create(display: Display): string {
    const session = Session.create(this.ivy.paths.sessions, this.ivy.agent.model);
    this.live.set(session.id, this.hold(session));
    if (display !== "markdown") this.displays.set(session.id, display);
    void this.ivy.systemPrompt.start(session.id, DISPLAY_INSTRUCTIONS[display]);
    return session.id;
  }

  view(id: string): SessionView {
    const live = this.get(id);
    const messages = live.running
      ? live.session.messages.slice(0, live.running.before)
      : live.session.messages;
    // The text still being written goes apart, so a client can keep streaming into it.
    const turn = [...(live.running?.entries ?? [])];
    const last = turn.at(-1);
    const streaming = live.running?.open && last?.kind === "assistant" ? last.markdown : undefined;
    if (streaming !== undefined) turn.pop();
    const entries = [...this.entries(live.session, messages), ...turn];
    const permission = [...this.asks.values()].find((p) => p.ask.sessionId === id)?.ask;
    return {
      id,
      entries,
      running: live.running?.prompt,
      ...(streaming !== undefined && { streaming }),
      queue: [...live.queue],
      tokens: tokensFromUsage(summarizeUsage(this.ivy.paths.sessions, { sessionId: id })),
      ...(permission && { permission }),
    };
  }

  /**
   * Take a message for a session: it runs now, or after the turns before it. Its images,
   * uploaded as they were attached, move to the session's folder now (DESIGN.md §5.4).
   */
  send(id: string, text: string, images: string[] = []): Prompt {
    if (this.closed) throw new Error("The daemon is stopping");
    const live = this.get(id);
    try {
      claimUploads(this.ivy.paths.uploads, live.session.imagesDir, images);
    } catch (err) {
      throw new PromptError(errorMessage(err));
    }
    const prompt: Prompt = { id: crypto.randomUUID(), text, ...(images.length && { images }) };
    live.queue.push(prompt);
    this.publish({ sessionId: id, type: "prompt", prompt });
    // Started a step later, so `pumping` is set before the drain can clear it.
    live.pumping ??= Promise.resolve().then(() => this.drain(id, live));
    return prompt;
  }

  /** Take back a message still waiting; false if it already ran or never was. */
  withdraw(id: string, promptId: string): boolean {
    const live = this.get(id);
    const i = live.queue.findIndex((p) => p.id === promptId);
    if (i < 0) return false;
    live.queue.splice(i, 1);
    this.publish({ sessionId: id, type: "prompt_withdrawn", promptId });
    return true;
  }

  /** Stop the running turn, and with `clearQueue` the waiting messages too. */
  interrupt(id: string, clearQueue: boolean): void {
    const live = this.get(id);
    if (clearQueue) {
      for (const p of [...live.queue]) this.withdraw(id, p.id);
    }
    live.running?.controller.abort();
    // A prompt waiting for an answer holds the turn up: answer it for the user.
    for (const [askId, pending] of this.asks) {
      if (pending.ask.sessionId === id) this.answer(askId, "deny");
    }
  }

  /** A turn's permission prompt: ask every client, and wait for the first answer. */
  private confirm(sessionId: string, call: ToolCallRequest): Promise<PermissionChoice> {
    return new Promise((resolve) => {
      const ask: PermissionAsk = {
        id: crypto.randomUUID(),
        sessionId,
        name: call.name,
        label: this.ivy.plugins.toolLabel(call.name, call.input),
        input: call.input,
        risk: call.risk,
        reason: call.reason,
        // Only once or no where remembering would have no effect (dangerous tools, ask rules).
        choices: call.canRemember ? [...PERMISSION_ANSWERS] : ["once", "deny"],
      };
      const timer = setTimeout(() => this.answer(ask.id, "unanswered"), this.permissionTimeoutMs);
      this.asks.set(ask.id, {
        ask,
        resolve: (choice) => {
          clearTimeout(timer);
          resolve(choice);
        },
      });
      this.publish({ sessionId: ask.sessionId, type: "permission", ask });
    });
  }

  /** Answer a permission prompt; false if it was already answered (or never asked). */
  answer(askId: string, choice: PermissionChoice): boolean {
    const pending = this.asks.get(askId);
    if (!pending) return false;
    this.asks.delete(askId);
    pending.resolve(choice);
    this.publish({
      sessionId: pending.ask.sessionId,
      type: "permission_answered",
      id: askId,
      choice,
    });
    return true;
  }

  /**
   * Delete a session: let it go and move its file to the trash. False while a turn runs or
   * waits in it, which would go on writing to it; stop it first.
   */
  delete(id: string): boolean {
    const live = this.live.get(id);
    if (live?.pumping) return false;
    const trashed = trashSession(this.ivy.paths.sessions, id);
    if (!live && !trashed) throw new SessionNotFoundError(`Session not found: ${id}`);
    if (live) {
      this.live.delete(id);
      this.displays.delete(id);
      this.ivy.releaseSession(id);
    }
    return true;
  }

  /** An image sent in a session, or undefined if there is none by that name. */
  imageFile(id: string, name: string): string | undefined {
    if (!isSessionId(id) || !isImageName(name)) return undefined;
    const file = join(this.ivy.paths.sessions, id, name);
    return existsSync(file) ? file : undefined;
  }

  /** A session's file, for /status (it exists once the first message is written). */
  fileOf(id: string): string {
    return this.get(id).session.file;
  }

  /** Whether any turn runs or waits, in any session. */
  get busy(): boolean {
    return [...this.live.values()].some((l) => l.running || l.queue.length > 0);
  }

  /** How many sessions are held in memory. */
  get loaded(): number {
    return this.live.size;
  }

  /**
   * Let go of sessions idle for IDLE_MS, with nothing running or waiting. One never written
   * (started, no message yet) is kept: it isn't on disk to load again, and it is small.
   */
  sweep(): void {
    for (const [id, live] of this.live) {
      if (live.pumping || this.now() - live.touched < IDLE_MS) continue;
      if (!existsSync(live.session.file)) continue;
      this.live.delete(id);
      this.ivy.releaseSession(id);
    }
  }

  /**
   * Stop for shutdown: no new messages, waiting ones dropped, running turns interrupted
   * and given a moment to write what they have.
   */
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.sweeper);
    for (const id of this.live.keys()) this.interrupt(id, true);
    const pumping = [...this.live.values()].flatMap((l) => (l.pumping ? [l.pumping] : []));
    await Promise.race([Promise.all(pumping), Bun.sleep(CLOSE_WAIT_MS)]);
  }

  /** A session held here, loaded from disk when first asked for. */
  private get(id: string): Live {
    let live = this.live.get(id);
    if (live) {
      live.touched = this.now();
    } else {
      let session: Session;
      try {
        session = Session.load(this.ivy.paths.sessions, id);
      } catch {
        throw new SessionNotFoundError(`Session not found: ${id}`);
      }
      live = this.hold(session);
      this.live.set(id, live);
      const display = this.displays.get(id) ?? "markdown";
      void this.ivy.systemPrompt.start(id, DISPLAY_INSTRUCTIONS[display]);
    }
    return live;
  }

  private hold(session: Session): Live {
    return { session, tracer: this.ivy.tracer(session.id), touched: this.now(), queue: [] };
  }

  /**
   * Run the waiting messages one turn at a time. `pumping` is cleared in the same step that
   * finds the queue empty, so a message sent right then starts a new drain instead of
   * waiting for one that is ending.
   */
  private async drain(id: string, live: Live): Promise<void> {
    for (;;) {
      const prompt = live.queue.shift();
      if (!prompt) {
        live.pumping = undefined;
        return;
      }
      await this.runTurn(id, live, prompt);
    }
  }

  private async runTurn(id: string, live: Live, prompt: Prompt): Promise<void> {
    const running = {
      prompt,
      controller: new AbortController(),
      before: live.session.messages.length,
      entries: [
        {
          kind: "user",
          text: prompt.text,
          ...(prompt.images && { images: prompt.images }),
        } as Entry,
      ],
      open: false,
    };
    live.running = running;
    this.publish({ sessionId: id, type: "turn_start", prompt });

    let end: TurnEnd;
    try {
      end = await this.ivy.agent.runTurn(live.session, prompt, {
        signal: running.controller.signal,
        tracer: live.tracer,
        confirm: (call) => this.confirm(id, call),
        onEvent: (event) => this.onAgentEvent(id, running, event),
      });
    } catch (err) {
      end = { stopReason: "error", steps: 0, costUsd: 0, error: errorMessage(err) };
    }
    live.running = undefined;
    live.touched = this.now(); // idle from when the turn ends, not when it was asked for
    this.publish({ sessionId: id, type: "turn_end", promptId: prompt.id, end });
  }

  /** Pass an agent event on to clients, and keep the turn so far for clients that open it. */
  private onAgentEvent(
    sessionId: string,
    running: NonNullable<Live["running"]>,
    e: AgentEvent,
  ): void {
    const { entries } = running;
    switch (e.type) {
      case "text": {
        const last = entries.at(-1);
        if (running.open && last?.kind === "assistant") last.markdown += e.delta;
        else entries.push({ kind: "assistant", markdown: e.delta });
        running.open = true;
        this.publish({ sessionId, type: "text", delta: e.delta });
        return;
      }
      case "tool_call": {
        running.open = false;
        const label = this.ivy.plugins.toolLabel(e.name, e.input);
        entries.push({
          kind: "tool",
          id: e.id,
          name: e.name,
          label,
          input: e.input,
          result: "",
          isError: false,
          running: true,
        });
        this.publish({
          sessionId,
          type: "tool_call",
          id: e.id,
          name: e.name,
          label,
          input: e.input,
        });
        return;
      }
      case "tool_result": {
        const entry = entries.find((x) => x.kind === "tool" && x.id === e.id);
        if (entry?.kind !== "tool") return; // every result follows its call
        entry.result = e.content;
        entry.isError = e.isError;
        entry.running = undefined;
        this.publish({ sessionId, ...e, label: entry.label });
        return;
      }
      case "step": {
        running.open = false;
        this.publish({ sessionId, ...e, usage: tokenCounts(e.usage) });
        return;
      }
      case "notice":
      case "context":
      case "request":
        this.publish({ sessionId, ...e });
        return;
    }
  }

  /** A stored transcript as clients show it: what was said, and tool calls with their results. */
  private entries(session: Session, messages: Session["messages"]): Entry[] {
    const results = new Map<string, { content: string; isError: boolean }>();
    for (const m of messages) {
      if (m.role !== "user" || typeof m.content === "string") continue;
      for (const b of m.content) {
        if (b.type !== "tool_result") continue;
        const content =
          typeof b.content === "string"
            ? b.content
            : (b.content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join(" ");
        results.set(b.tool_use_id, { content, isError: b.is_error ?? false });
      }
    }
    const entries: Entry[] = [];
    for (const m of messages) {
      if (m.role === "user") {
        const text = promptText(m); // what the user typed: no context block, no tool results
        const images =
          typeof m.content === "string" ? [] : m.content.flatMap((b) => session.imageOf(b) ?? []);
        if (text?.trim() || images.length) {
          entries.push({ kind: "user", text: text ?? "", ...(images.length && { images }) });
        }
      } else if (typeof m.content === "string") {
        if (m.content.trim()) entries.push({ kind: "assistant", markdown: m.content });
      } else {
        for (const b of m.content) {
          if (b.type === "text" && b.text.trim()) {
            entries.push({ kind: "assistant", markdown: b.text });
          } else if (b.type === "tool_use") {
            const result = results.get(b.id) ?? { content: "(no result)", isError: true };
            entries.push({
              kind: "tool",
              id: b.id,
              name: b.name,
              label: this.ivy.plugins.toolLabel(b.name, b.input),
              input: b.input,
              result: result.content,
              isError: result.isError,
            });
          }
        }
      }
    }
    return entries;
  }
}
