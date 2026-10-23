import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryKeyStore, resolvePaths } from "@ivy/kernel";
import { PNG, ScriptedModel, type Step, text, toolUse } from "@ivy/kernel/testing";
import { definePlugin, defineTool } from "@ivy/plugin-api";
import type { SessionEvent, SessionSummary, SessionView } from "@ivy/protocol";
import { z } from "zod";
import { type Served, serve } from "./index.ts";
import { IDLE_MS } from "./sessions.ts";

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

const running: Served[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

async function start(script: Step[], permissionTimeoutMs?: number, listed?: string[]) {
  const home = mkdtempSync(join(tmpdir(), "ivy-s-"));
  writeFileSync(
    join(home, "config.toml"),
    '[agent]\nmodel = "anthropic/claude-opus-5-5"\n[providers.anthropic]\napi_key = "test"\nmodels = ["claude-opus-5-5"]\n',
  );
  const paths = resolvePaths(home);
  const model = new ScriptedModel(script, listed);
  // Never the real Keychain.
  const keys = new MemoryKeyStore();
  const clock = { now: Date.now() };
  const served = await serve({
    paths,
    plugins: [tools],
    model,
    keys,
    permissionTimeoutMs,
    now: () => clock.now,
    // Every model call here answers the script.
    sumUp: false,
  });
  running.push(served);
  const { sessions } = served;

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://ivy${path}`, {
      method,
      unix: paths.daemonSocket,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  return { call, socket: paths.daemonSocket, sessions, model, clock, keys, paths };
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

test("images: uploaded as attached, named by a prompt, kept with the session and shown", async () => {
  const { call, socket, model } = await start([{ content: [text("A small picture.")] }]);
  const upload = (bytes: Uint8Array, type: string) =>
    fetch("http://ivy/images", {
      method: "POST",
      unix: socket,
      body: bytes,
      headers: { "content-type": type },
    });
  const uploaded = await upload(PNG, "image/png");
  expect(uploaded.status).toBe(201);
  const { name } = (await uploaded.json()) as { name: string };
  expect((await upload(PNG, "image/heic")).status).toBe(400);

  const { body: created } = await call("POST", "/sessions", {});
  const client = await follow(socket);
  expect(
    (await call("POST", `/sessions/${created.id}/prompts`, { images: [`${"0".repeat(64)}.png`] }))
      .status,
  ).toBe(400);
  expect((await call("POST", `/sessions/${created.id}/prompts`, {})).status).toBe(400);
  const sent = await call("POST", `/sessions/${created.id}/prompts`, { images: [name] });
  expect(sent.body).toMatchObject({ text: "", images: [name] });
  await client.until((e) => e.type === "turn_end");
  expect(model.requests[0]?.messages[0]?.content).toContainEqual(
    expect.objectContaining({ type: "image" }),
  );

  const view = (await call("GET", `/sessions/${created.id}`)).body as SessionView;
  expect(view.entries[0]).toEqual({ kind: "user", text: "", images: [name] });
  const image = await fetch(`http://ivy/sessions/${created.id}/images/${name}`, { unix: socket });
  expect(image.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG);
  expect((await call("GET", `/sessions/${created.id}/images/..%2Fx.png`)).status).toBe(404);
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

test("a Markdown session let go and loaded again keeps its instructions", async () => {
  const { call, socket, sessions, model, clock } = await start([
    { content: [text("one")] },
    { content: [text("two")] },
  ]);
  const client = await follow(socket);
  const id = (await call("POST", "/sessions", {})).body.id; // the default display
  const first = (await call("POST", `/sessions/${id}/prompts`, { text: "first" })).body;
  await client.until((e) => e.type === "turn_end" && e.promptId === first.id);
  clock.now += IDLE_MS + 1000;
  sessions.sweep();
  expect(sessions.loaded).toBe(0);
  const second = (await call("POST", `/sessions/${id}/prompts`, { text: "second" })).body;
  await client.until((e) => e.type === "turn_end" && e.promptId === second.id);
  expect(JSON.stringify(model.requests[1]?.system)).toContain("render Markdown");
  await client.close();
});

test("a session can be deleted, but not while Ivy replies in it", async () => {
  const slow = gate();
  const { call, socket } = await start([
    { content: [text("done")] },
    { content: [text("…")], gate: slow.promise },
  ]);
  const client = await follow(socket);
  const { body: kept } = await call("POST", "/sessions", {});
  await call("POST", `/sessions/${kept.id}/prompts`, { text: "keep" });
  await client.until((e) => e.type === "turn_end");
  const { body: busy } = await call("POST", "/sessions", {});
  await call("POST", `/sessions/${busy.id}/prompts`, { text: "busy" });
  await client.until((e) => e.type === "text" && e.sessionId === busy.id);

  expect((await call("DELETE", `/sessions/${busy.id}`)).status).toBe(409);
  expect((await call("DELETE", `/sessions/${kept.id}`)).status).toBe(204);
  expect((await call("GET", `/sessions/${kept.id}`)).status).toBe(404);
  expect((await call("DELETE", `/sessions/${kept.id}`)).status).toBe(404);
  const list = (await call("GET", "/sessions")).body as SessionSummary[];
  expect(list.map((s) => s.id)).toEqual([busy.id]);
  // One started but never written is let go too.
  const { body: empty } = await call("POST", "/sessions", {});
  expect((await call("DELETE", `/sessions/${empty.id}`)).status).toBe(204);
  expect((await call("GET", `/sessions/${empty.id}`)).status).toBe(404);
  slow.open();
  await client.close();
});

test("an endpoint that takes the key but lists nothing is told apart: its models are named instead", async () => {
  const { call } = await start([]);
  const tested = await call("POST", "/provider-test", { base_url: "http://127.0.0.1:9", key: "k" });
  expect(tested).toMatchObject({ status: 200, body: { models: [], unlisted: expect.any(String) } });
});

test("the helper model is set, saved and taken out; one on no provider is refused", async () => {
  const { call, paths } = await start([]);
  expect((await call("GET", "/state")).body.helperModel).toBe("");
  const set = await call("PUT", "/helper-model", { model: "anthropic/claude-haiku-5-5" });
  expect(set.body).toMatchObject({ helperModel: "anthropic/claude-haiku-5-5", saved: true });
  expect(readFileSync(paths.config, "utf8")).toContain(
    'helper_model = "anthropic/claude-haiku-5-5"',
  );
  expect((await call("PUT", "/helper-model", { model: "nowhere/m" })).status).toBe(400);
  const cleared = await call("PUT", "/helper-model", { model: "" });
  expect(cleared.body).toMatchObject({ helperModel: "", saved: true });
  expect(readFileSync(paths.config, "utf8")).not.toContain("helper_model");
});

test("settings: providers added, keyed, changed and removed; keys never shown", async () => {
  const { call, keys, paths } = await start([], undefined, ["m1", "m2"]);
  const settings = await call("GET", "/settings");
  expect(settings.status).toBe(200);
  expect(settings.body.providers).toEqual([
    expect.objectContaining({ name: "anthropic", key: "config", inUse: true, official: true }),
  ]);
  expect(JSON.stringify(settings.body)).not.toContain('"test"'); // the key itself

  // A connection test lists the endpoint's models, nothing saved.
  const tested = await call("POST", "/provider-test", { base_url: "http://127.0.0.1:9", key: "k" });
  expect(tested).toEqual({ status: 200, body: { models: ["m1", "m2"] } });
  expect(await call("POST", "/provider-test", {})).toMatchObject({ status: 400 });

  const added = await call("POST", "/providers", {
    name: "proxy",
    base_url: "http://127.0.0.1:9",
    key: "sk-proxy",
  });
  expect(added.status).toBe(200);
  expect(keys.get("proxy")).toBe("sk-proxy");
  expect(added.body.providers[1]).toMatchObject({ name: "proxy", key: "keychain", inUse: false });
  expect(readFileSync(paths.config, "utf8")).not.toContain("sk-proxy");
  // Its models are offered at once.
  expect((await call("GET", "/models")).body.models).toContain("proxy/m1");

  const changed = await call("PUT", "/providers/proxy", { models: ["m2"] });
  expect(changed.body.providers[1].models).toEqual(["m2"]);

  // A key in config.toml moves to the Keychain as it is, out of the file.
  const moved = await call("PUT", "/providers/anthropic/key", {});
  expect(moved.body.providers[0].key).toBe("keychain");
  expect(keys.get("anthropic")).toBe("test");
  expect(readFileSync(paths.config, "utf8")).not.toContain('api_key = "test"');
  expect(await call("PUT", "/providers/anthropic/key", {})).toMatchObject({ status: 400 });
  // A new one replaces it.
  await call("PUT", "/providers/anthropic/key", { key: "sk-new" });
  expect(keys.get("anthropic")).toBe("sk-new");

  // The provider of the model in use stays.
  expect(await call("DELETE", "/providers/anthropic")).toMatchObject({ status: 409 });
  expect(await call("DELETE", "/providers/anthropic/key")).toMatchObject({ status: 409 });
  const removed = await call("DELETE", "/providers/proxy");
  expect(removed.body.providers.map((p: { name: string }) => p.name)).toEqual(["anthropic"]);
  expect(keys.get("proxy")).toBeUndefined();
  expect(await call("PUT", "/providers/nope", {})).toMatchObject({ status: 404 });
});

test("a search shows with its result when the session is opened, even across a paused reply", async () => {
  const search = (block: object) => block as unknown as ReturnType<typeof text>;
  const { call, socket } = await start([
    {
      content: [
        search({
          type: "server_tool_use",
          id: "srv_1",
          name: "web_search",
          input: { query: "finale" },
        }),
      ],
      stop: "pause_turn",
    },
    {
      content: [
        search({
          type: "web_search_tool_result",
          tool_use_id: "srv_1",
          content: [
            {
              type: "web_search_result",
              title: "Finale",
              url: "https://a.example/f",
              encrypted_content: "x",
              page_age: null,
            },
          ],
        }),
        text("Friday."),
      ],
    },
  ]);
  const client = await follow(socket);
  const id = (await call("POST", "/sessions", {})).body.id;
  await call("POST", `/sessions/${id}/prompts`, { text: "when is the finale?" });
  await client.until((e) => e.type === "turn_end");
  const view = (await call("GET", `/sessions/${id}`)).body as SessionView;
  expect(view.entries.filter((e) => e.kind !== "user")).toMatchObject([
    {
      kind: "tool",
      id: "srv_1",
      name: "web_search",
      result: "Finale — https://a.example/f",
      isError: false,
    },
    { kind: "assistant", markdown: "Friday." },
  ]);
  await client.close();
});
