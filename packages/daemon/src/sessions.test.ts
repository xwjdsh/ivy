import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createIvy,
  type ModelClient,
  type ModelMessage,
  type ModelRequest,
  resolvePaths,
} from "@ivy/kernel";
import { definePlugin, defineTool } from "@ivy/plugin-api";
import type { SessionEvent, SessionSummary, SessionView } from "@ivy/protocol";
import { z } from "zod";
import { api } from "./api.ts";
import { type Daemon, startDaemon } from "./server.ts";
import { IDLE_MS, Sessions } from "./sessions.ts";

type Block = ModelMessage["content"][number];
const text = (t: string) => ({ type: "text", text: t, citations: null }) as unknown as Block;
const toolUse = (id: string, name: string, input: unknown = {}) =>
  ({ type: "tool_use", id, name, input }) as unknown as Block;

/** A reply, sent once `gate` (if any) opens; an aborted call rejects, as the SDK's does. */
interface Step {
  content: Block[];
  stop?: string;
  gate?: Promise<void>;
}

class FakeModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  constructor(private readonly script: Step[]) {}
  async stream(request: ModelRequest, handlers: { onText?(d: string): void }, signal: AbortSignal) {
    this.requests.push(request);
    const step = this.script.shift();
    if (!step) throw new Error("script exhausted");
    for (const b of step.content) if (b.type === "text") handlers.onText?.(b.text);
    if (step.gate) {
      await Promise.race([
        step.gate,
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
      ]);
    }
    return {
      id: "msg",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: step.content,
      stop_reason: step.stop ?? "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    } as unknown as ModelMessage;
  }
}

const tools = definePlugin({
  id: "t",
  version: "0",
  description: "",
  tools: [
    defineTool({
      name: "save",
      description: "save",
      input: z.object({ what: z.string() }),
      risk: "write",
      summary: (i) => `save: ${i.what}`,
      run: (i) => `saved ${i.what}`,
    }),
  ],
});

const gate = () => {
  let open = () => {};
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
};

const running: Array<{ daemon: Daemon; sessions: Sessions }> = [];
afterEach(async () => {
  for (const r of running.splice(0)) {
    await r.sessions.close();
    await r.daemon.stop();
  }
});

async function start(script: Step[], permissionTimeoutMs?: number) {
  const home = mkdtempSync(join(tmpdir(), "ivy-s-"));
  writeFileSync(
    join(home, "config.toml"),
    '[agent]\nmodel = "anthropic/claude-opus-5-5"\n[providers.anthropic]\napi_key = "test"\nmodels = ["claude-opus-5-5"]\n',
  );
  const paths = resolvePaths(home);
  let sessions: Sessions | undefined;
  const model = new FakeModel(script);
  const clock = { now: Date.now() };
  const ivy = await createIvy({
    plugins: [tools],
    model,
    paths,
    confirm: (call) => (sessions as Sessions).confirm(call),
  });
  let daemon: Daemon | undefined;
  sessions = new Sessions({
    ivy,
    publish: (event) => daemon?.publish({ type: "session", data: event }),
    permissionTimeoutMs,
    now: () => clock.now,
  });
  daemon = await startDaemon(paths, api(ivy, sessions));
  running.push({ daemon, sessions });

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://ivy${path}`, {
      method,
      unix: paths.daemonSocket,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  return { call, socket: paths.daemonSocket, sessions, model, clock };
}

/** A client of /events: collects session events, and waits for one that matches. */
async function follow(socket: string) {
  const res = await fetch("http://ivy/events", { unix: socket });
  const reader = res.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const events: SessionEvent[] = [];
  let buffer = "";
  const waiters: Array<() => void> = [];
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buffer += new TextDecoder().decode(value);
      let end = buffer.indexOf("\n\n");
      while (end >= 0) {
        const chunk = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (chunk.startsWith("event: session\n")) {
          events.push(JSON.parse(chunk.slice(chunk.indexOf("data: ") + 6)));
          for (const w of waiters.splice(0)) w();
        }
        end = buffer.indexOf("\n\n");
      }
    }
  })();
  const until = async (match: (e: SessionEvent) => boolean): Promise<SessionEvent> => {
    for (;;) {
      const found = events.find(match);
      if (found) return found;
      await new Promise<void>((r) => waiters.push(r));
    }
  };
  return { events, until, close: () => reader.cancel() };
}

const types = (events: SessionEvent[]) => events.map((e) => e.type);

test("a prompt runs as a turn, streamed to the client, and the session shows it", async () => {
  const { call, socket } = await start([{ content: [text("Hello!")] }]);
  const client = await follow(socket);
  const { body: created, status } = await call("POST", "/sessions", {});
  expect(status).toBe(201);
  const sent = await call("POST", `/sessions/${created.id}/prompts`, { text: "hi" });
  expect(sent.status).toBe(202);

  await client.until((e) => e.type === "turn_end");
  expect(types(client.events)).toEqual([
    "prompt",
    "turn_start",
    "request",
    "text",
    "step",
    "turn_end",
  ]);
  expect(client.events.every((e) => e.sessionId === created.id)).toBe(true);

  const view = (await call("GET", `/sessions/${created.id}`)).body as SessionView;
  expect(view.entries).toEqual([
    { kind: "user", text: "hi" },
    { kind: "assistant", markdown: "Hello!" },
  ]);
  expect(view.tokens).toEqual({ in: 10, cached: 0, out: 5 });
  const list = (await call("GET", "/sessions")).body as SessionSummary[];
  expect(list).toMatchObject([{ id: created.id, turns: 1, preview: "hi", busy: false }]);
  await client.close();
});

test("a message sent while a turn runs waits, then runs next, from any client", async () => {
  const first = gate();
  const { call, socket } = await start([
    { content: [text("one")], gate: first.promise },
    { content: [text("two")] },
  ]);
  const a = await follow(socket);
  const b = await follow(socket);
  const { body } = await call("POST", "/sessions", {});
  await call("POST", `/sessions/${body.id}/prompts`, { text: "first" });
  await a.until((e) => e.type === "text");
  // Another client sends while the first turn runs: it waits, it isn't refused.
  const second = (await call("POST", `/sessions/${body.id}/prompts`, { text: "second" })).body;
  let view = (await call("GET", `/sessions/${body.id}`)).body as SessionView;
  expect(view.running?.text).toBe("first");
  expect(view.queue).toEqual([second]);
  // The turn so far is part of the view, for a client that opens it now; the text still
  // being written comes apart, so the client can keep streaming into it.
  expect(view.entries).toEqual([{ kind: "user", text: "first" }]);
  expect(view.streaming).toBe("one");

  first.open();
  await b.until((e) => e.type === "turn_end" && e.promptId === second.id);
  const starts = b.events.flatMap((e) => (e.type === "turn_start" ? [e.prompt.text] : []));
  expect(starts).toEqual(["first", "second"]);
  view = (await call("GET", `/sessions/${body.id}`)).body as SessionView;
  expect(view.entries.map((e) => (e.kind === "assistant" ? e.markdown : e.kind))).toEqual([
    "user",
    "one",
    "user",
    "two",
  ]);
  await a.close();
  await b.close();
});

test("a waiting message can be taken back; an interrupt may drop the rest", async () => {
  const slow = gate();
  const { call, socket } = await start([{ content: [text("…")], gate: slow.promise }]);
  const client = await follow(socket);
  const { body } = await call("POST", "/sessions", {});
  await call("POST", `/sessions/${body.id}/prompts`, { text: "run" });
  const wait1 = (await call("POST", `/sessions/${body.id}/prompts`, { text: "w1" })).body;
  const wait2 = (await call("POST", `/sessions/${body.id}/prompts`, { text: "w2" })).body;

  expect((await call("DELETE", `/sessions/${body.id}/prompts/${wait1.id}`)).status).toBe(204);
  expect((await call("DELETE", `/sessions/${body.id}/prompts/${wait1.id}`)).status).toBe(409);
  await client.until((e) => e.type === "text");
  await call("POST", `/sessions/${body.id}/interrupt`, { clearQueue: true });
  const end = await client.until((e) => e.type === "turn_end");
  expect(end.type === "turn_end" && end.end.stopReason).toBe("interrupted");
  const withdrawn = client.events.flatMap((e) =>
    e.type === "prompt_withdrawn" ? [e.promptId] : [],
  );
  expect(withdrawn).toEqual([wait1.id, wait2.id]);
  const view = (await call("GET", `/sessions/${body.id}`)).body as SessionView;
  expect(view.queue).toEqual([]);
  expect(view.running).toBeUndefined();
  await client.close();
});

test("every client is asked; the first answer counts and the rest are told", async () => {
  const { call, socket } = await start([
    { content: [toolUse("u1", "t__save", { what: "the plan" })], stop: "tool_use" },
    { content: [text("Saved.")] },
  ]);
  const a = await follow(socket);
  const b = await follow(socket);
  const { body } = await call("POST", "/sessions", {});
  await call("POST", `/sessions/${body.id}/prompts`, { text: "save it" });

  const asked = await b.until((e) => e.type === "permission");
  if (asked.type !== "permission") throw new Error("unreachable");
  expect(asked.ask).toMatchObject({
    name: "t__save",
    label: { plugin: "t", text: "save: the plan" },
    reason: "write tool",
    choices: ["once", "session", "always", "deny"],
  });
  await a.until((e) => e.type === "permission");
  const view = (await call("GET", `/sessions/${body.id}`)).body as SessionView;
  expect(view.permission?.id).toBe(asked.ask.id);
  expect(view.entries.at(-1)).toMatchObject({ kind: "tool", running: true, result: "" });

  expect((await call("POST", `/permissions/${asked.ask.id}`, { choice: "once" })).status).toBe(204);
  expect((await call("POST", `/permissions/${asked.ask.id}`, { choice: "deny" })).status).toBe(409);
  const answered = await a.until((e) => e.type === "permission_answered");
  expect(answered).toMatchObject({ choice: "once" });
  await a.until((e) => e.type === "turn_end");
  const result = a.events.find((e) => e.type === "tool_result");
  expect(result).toMatchObject({ content: "saved the plan", isError: false });
  await a.close();
  await b.close();
});

test("a permission prompt no one answers is refused, and the model is told why", async () => {
  const model = [
    { content: [toolUse("u1", "t__save", { what: "x" })], stop: "tool_use" },
    { content: [text("Okay.")] },
  ];
  const { call, socket } = await start(model, 50);
  const client = await follow(socket);
  const { body } = await call("POST", "/sessions", {});
  await call("POST", `/sessions/${body.id}/prompts`, { text: "save" });
  const answered = await client.until((e) => e.type === "permission_answered");
  expect(answered).toMatchObject({ choice: "unanswered" });
  const result = await client.until((e) => e.type === "tool_result");
  expect(result).toMatchObject({ isError: true });
  expect(result.type === "tool_result" && result.content).toContain("No one answered");
  await client.close();
});

test("bad requests are refused with a reason", async () => {
  const { call } = await start([]);
  const { body } = await call("POST", "/sessions", {});
  expect(await call("POST", `/sessions/${body.id}/prompts`, { text: "  " })).toMatchObject({
    status: 400,
  });
  expect(await call("GET", "/sessions/nope")).toMatchObject({
    status: 404,
    body: { error: "Session not found: nope" },
  });
  expect(await call("PUT", "/effort", { effort: "huge" })).toMatchObject({ status: 400 });
  expect(await call("GET", "/sessions/%E0%A4%A")).toMatchObject({ status: 400 });
  expect((await call("GET", "/state")).body).toMatchObject({ model: "anthropic/claude-opus-5-5" });
});

test("an idle session is let go, and loaded again as it was when asked for", async () => {
  const { call, socket, sessions, model, clock } = await start([
    { content: [text("one")] },
    { content: [text("two")] },
  ]);
  const client = await follow(socket);
  const plain = (await call("POST", "/sessions", { display: "plain" })).body.id;
  const unused = (await call("POST", "/sessions", {})).body.id;
  await call("POST", `/sessions/${plain}/prompts`, { text: "first" });
  await client.until((e) => e.type === "turn_end");
  const before = (await call("GET", `/sessions/${plain}`)).body as SessionView;

  clock.now += IDLE_MS - 1000;
  sessions.sweep();
  expect(sessions.loaded).toBe(2);
  clock.now += 2000;
  sessions.sweep();
  expect(sessions.loaded).toBe(1); // the unused one isn't on disk to load again: kept
  expect((await call("GET", `/sessions/${unused}`)).status).toBe(200);

  expect((await call("GET", `/sessions/${plain}`)).body).toEqual(before);
  const second = (await call("POST", `/sessions/${plain}/prompts`, { text: "second" })).body;
  await client.until((e) => e.type === "turn_end" && e.promptId === second.id);
  // Still a plain-text session after being loaded again.
  expect(JSON.stringify(model.requests[1]?.system)).toContain("plain text");
  await client.close();
});

test("closing interrupts running turns and refuses new messages", async () => {
  const never = gate();
  const { call, socket, sessions } = await start([{ content: [text("…")], gate: never.promise }]);
  const client = await follow(socket);
  const { body } = await call("POST", "/sessions", {});
  await call("POST", `/sessions/${body.id}/prompts`, { text: "go" });
  await call("POST", `/sessions/${body.id}/prompts`, { text: "waiting" });
  await client.until((e) => e.type === "text");
  await sessions.close();
  const end = await client.until((e) => e.type === "turn_end");
  expect(end.type === "turn_end" && end.end.stopReason).toBe("interrupted");
  expect(client.events.some((e) => e.type === "prompt_withdrawn")).toBe(true);
  expect(() => sessions.send(body.id, "late")).toThrow("stopping");
  await client.close();
});
