import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { definePlugin, defineTool, type IvyPlugin, type RiskLevel } from "@ivy/plugin-api";
import { z } from "zod";
import { Agent, type AgentEvent, type ToolCallRequest } from "./agent.ts";
import { Capabilities } from "./capabilities.ts";
import { loadConfig, type ProviderConfig, resolvePaths } from "./config.ts";
import { saveAllowRule } from "./config-edit.ts";
import { claimUploads, saveUpload } from "./images.ts";
import type { ModelClient, ModelMessage, ModelRequest, RequestExtras } from "./model.ts";
import { type PermissionChoice, Permissions } from "./permissions.ts";
import { PluginHost } from "./plugins.ts";
import { Session, sessionHistory } from "./session.ts";
import { PNG } from "./testing.ts";

/** Search blocks as the vendor returns them. */
const search = (id: string, query: string) =>
  [
    { type: "server_tool_use", id, name: "web_search", input: { query } },
    {
      type: "web_search_tool_result",
      tool_use_id: id,
      content: [
        {
          type: "web_search_result",
          title: "Finale",
          url: "https://a.example/f",
          encrypted_content: "x",
          page_age: null,
        },
      ],
    },
  ] as unknown as Block[];

/** A page tool that brings outside content, and a note tool that asks once that has happened. */
function outsidePlugin(seen: boolean[], turns: number[] = []) {
  return definePlugin({
    id: "w",
    version: "0",
    description: "test",
    tools: [
      defineTool({
        name: "page",
        description: "page",
        input: z.object({}),
        risk: "read",
        run: () => ({ content: "a page someone else wrote", outside: true }),
      }),
      defineTool({
        name: "note",
        description: "note",
        input: z.object({}),
        risk: "write",
        defaultAllow: true,
        askFirst: (_, { tainted }) => (tainted ? "read outside content" : undefined),
        run: (_, ctx) => {
          seen.push(ctx.tainted);
          turns.push(ctx.turn);
          return "noted";
        },
      }),
    ],
  });
}

type Block = ModelMessage["content"][number];

function reply(stop_reason: string, content: Block[]): ModelMessage {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 10 },
  } as unknown as ModelMessage;
}

const text = (t: string) => ({ type: "text", text: t, citations: null }) as unknown as Block;
const toolUse = (id: string, name: string, input: unknown = {}) =>
  ({ type: "tool_use", id, name, input }) as unknown as Block;

/** Returns scripted responses in order and records every request it saw. */
class FakeModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  readonly extras: Array<RequestExtras | undefined> = [];
  constructor(readonly script: Array<ModelMessage | (() => never)>) {}

  async stream(
    request: ModelRequest,
    handlers: { onText?(d: string): void; onBlock?(b: Block): void },
    _signal?: AbortSignal,
    extras?: RequestExtras,
  ) {
    this.requests.push(request);
    this.extras.push(extras);
    const next = this.script.shift();
    if (!next) throw new Error("script exhausted");
    if (typeof next === "function") next();
    const message = next as ModelMessage;
    for (const b of message.content) {
      if (b.type === "text") handlers.onText?.(b.text);
      handlers.onBlock?.(b);
    }
    return message;
  }
}

function testPlugin(risk: RiskLevel = "read") {
  return definePlugin({
    id: "t",
    version: "0",
    description: "test",
    tools: [
      defineTool({
        name: "echo",
        description: "echo",
        input: z.object({ msg: z.string() }),
        risk,
        run: ({ msg }) => `echo:${msg}`,
      }),
    ],
  });
}

describe("Agent.runTurn", () => {
  let dir: string;
  let session: Session;
  let events: AgentEvent[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ivy-test-"));
    session = Session.create(join(dir, "sessions"), "claude-opus-5-5");
    events = [];
  });

  const OPUS = '[agent]\nmodel = "anthropic/claude-opus-5-5"\n[providers.anthropic]\n';

  /** `model` answers for every provider, or give one client per provider name. */
  async function makeAgent(
    model: ModelClient | Record<string, ModelClient>,
    risk: RiskLevel = "read",
    confirm: (c: ToolCallRequest) => Promise<PermissionChoice> = async () => "once",
    systemPrompt = "sys",
    extraPlugins: IvyPlugin[] = [],
    toml = OPUS,
    extraToml = "",
  ) {
    const paths = resolvePaths(dir);
    writeFileSync(paths.config, `${toml}${extraToml}`);
    const plugins = new PluginHost(paths.data, {});
    await plugins.register(testPlugin(risk));
    for (const p of extraPlugins) await plugins.register(p);
    const config = loadConfig(paths);
    const capabilities = new Capabilities(
      join(dir, "cache", "models.json"),
      config.generation.effort,
    );
    const permissions = new Permissions(
      config.permissions,
      (tool) => saveAllowRule(paths, tool),
      (tool) => plugins.isDefaultAllowed(tool),
    );
    const clientFor = (provider: ProviderConfig) => {
      if ("stream" in model) return model as ModelClient;
      const client = (model as Record<string, ModelClient>)[provider.name];
      if (!client) throw new Error(`no client for ${provider.name}`);
      return client;
    };
    const agent = new Agent({
      config,
      clientFor,
      plugins,
      systemPrompt: async () => systemPrompt,
      capabilities,
      permissions,
    });
    confirms.set(agent, confirm);
    return agent;
  }

  /** Who answers each agent's permission prompts (passed with every turn). */
  const confirms = new WeakMap<Agent, (c: ToolCallRequest) => Promise<PermissionChoice>>();
  const run = (agent: Agent, input: string, signal = new AbortController().signal) =>
    agent.runTurn(session, input, {
      signal,
      onEvent: (e) => events.push(e),
      confirm: confirms.get(agent) ?? (async () => "once"),
    });

  test("plain answer ends the turn", async () => {
    const model = new FakeModel([reply("end_turn", [text("hi")])]);
    const result = await run(await makeAgent(model), "hello");
    expect(result.stopReason).toBe("end_turn");
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(model.requests[0]?.tools?.map((t) => ("name" in t ? t.name : ""))).toEqual(["t__echo"]);
  });

  test("tool call runs and its result is sent back", async () => {
    const model = new FakeModel([
      reply("tool_use", [toolUse("tu_1", "t__echo", { msg: "x" })]),
      reply("end_turn", [text("done")]),
    ]);
    const result = await run(await makeAgent(model), "go");
    expect(result).toMatchObject({ stopReason: "end_turn", steps: 2 });
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(session.messages[2]?.content).toEqual([
      { type: "tool_result", tool_use_id: "tu_1", content: "echo:x", is_error: undefined },
    ]);
    // Second request includes the tool result.
    expect(model.requests[1]?.messages).toHaveLength(3);
  });

  test("invalid tool input becomes an error result, not an exception", async () => {
    const model = new FakeModel([
      reply("tool_use", [toolUse("tu_1", "t__echo", { msg: 42 })]),
      reply("end_turn", [text("ok")]),
    ]);
    await run(await makeAgent(model), "go");
    const result = events.find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ isError: true });
  });

  test("risky tools ask for confirmation and denial is reported to the model", async () => {
    const asked: ToolCallRequest[] = [];
    const model = new FakeModel([
      reply("tool_use", [toolUse("tu_1", "t__echo", { msg: "x" })]),
      reply("end_turn", [text("ok")]),
    ]);
    const agent = await makeAgent(model, "external", async (c) => {
      asked.push(c);
      return "deny";
    });
    await run(agent, "go");
    expect(asked).toHaveLength(1);
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({
      content: "The user denied this tool call.",
      isError: true,
    });
  });

  test("a made-up tool name fails without asking", async () => {
    let asked = 0;
    const model = new FakeModel([
      reply("tool_use", [toolUse("tu_1", "t__nope", {})]),
      reply("end_turn", [text("ok")]),
    ]);
    await run(
      await makeAgent(model, "write", async () => {
        asked++;
        return "once";
      }),
      "go",
    );
    expect(asked).toBe(0);
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({
      content: "Unknown tool: t__nope",
      isError: true,
    });
  });

  test("a deny rule blocks a call without asking", async () => {
    let asked = 0;
    const model = new FakeModel([
      reply("tool_use", [toolUse("tu_1", "t__echo", { msg: "x" })]),
      reply("end_turn", [text("ok")]),
    ]);
    const agent = await makeAgent(
      model,
      "read",
      async () => {
        asked++;
        return "once";
      },
      "sys",
      [],
      undefined,
      '[permissions]\ndeny = ["t__*"]\n',
    );
    await run(agent, "go");
    expect(asked).toBe(0);
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({
      content: "This tool call is blocked by a permission rule.",
      isError: true,
    });
  });

  test("an ask rule makes even a 'read' tool ask", async () => {
    const asked: ToolCallRequest[] = [];
    const model = new FakeModel([
      reply("tool_use", [toolUse("tu_1", "t__echo", { msg: "x" })]),
      reply("end_turn", [text("ok")]),
    ]);
    const agent = await makeAgent(
      model,
      "read",
      async (c) => {
        asked.push(c);
        return "once";
      },
      "sys",
      [],
      undefined,
      '[permissions]\nask = ["t__echo"]\n',
    );
    await run(agent, "go");
    expect(asked).toEqual([
      {
        name: "t__echo",
        input: { msg: "x" },
        risk: "read",
        reason: "ask rule",
        canRemember: false,
      },
    ]);
  });

  test("'always' sticks across a restart (a fresh agent doesn't ask again)", async () => {
    let asked = 0;
    const confirm = async () => {
      asked++;
      return "always" as const;
    };
    const script = () => [
      reply("tool_use", [toolUse("tu_1", "t__echo", { msg: "x" })]),
      reply("end_turn", [text("ok")]),
    ];
    await run(await makeAgent(new FakeModel(script()), "write", confirm), "go");
    expect(asked).toBe(1);
    const saved = readFileSync(join(dir, "config.toml"), "utf8");
    expect(saved).toContain('[permissions]\nallow = ["t__echo"]');
    // A fresh agent over the saved config (the helper rewrites config.toml, so pass it on).
    session = Session.create(join(dir, "sessions"), "m");
    const extra = saved.slice(saved.indexOf("[permissions]"));
    await run(
      await makeAgent(
        new FakeModel(script()),
        "write",
        confirm,
        "sys",
        [],
        undefined,
        `\n${extra}`,
      ),
      "go again",
    );
    expect(asked).toBe(1);
  });

  test("refusal is not added to history", async () => {
    const model = new FakeModel([reply("refusal", [text("partial")])]);
    const result = await run(await makeAgent(model), "bad");
    expect(result.stopReason).toBe("refusal");
    expect(session.messages.map((m) => m.role)).toEqual(["user"]);
  });

  test("truncated tool input at max_tokens is never executed", async () => {
    const model = new FakeModel([reply("max_tokens", [toolUse("tu_1", "t__echo", { msg: "x" })])]);
    const result = await run(await makeAgent(model), "go");
    expect(result.stopReason).toBe("max_tokens");
    expect(events.some((e) => e.type === "tool_result")).toBe(false);
  });

  test("max_steps stops an endless tool loop", async () => {
    const loop = Array.from({ length: 30 }, (_, i) =>
      reply("tool_use", [toolUse(`tu_${i}`, "t__echo", { msg: "x" })]),
    );
    const result = await run(await makeAgent(new FakeModel(loop)), "go");
    expect(result).toMatchObject({ stopReason: "max_steps", steps: 25 });
  });

  test("interruption mid-stream leaves a valid, resumable history", async () => {
    const controller = new AbortController();
    const model = new FakeModel([
      () => {
        controller.abort();
        throw new Error("aborted");
      },
    ]);
    const result = await run(await makeAgent(model), "go", controller.signal);
    expect(result.stopReason).toBe("interrupted");
    const reloaded = Session.load(join(dir, "sessions"), session.id);
    expect(reloaded.messages).toEqual([{ role: "user", content: "go" }]);
  });

  test("unparseable streamed tool JSON is retried", async () => {
    const model = new FakeModel([
      () => {
        throw new Anthropic.AnthropicError("Unable to parse tool parameter JSON from model. ...");
      },
      reply("end_turn", [text("ok")]),
    ]);
    const result = await run(await makeAgent(model), "go");
    expect(result.stopReason).toBe("end_turn");
    expect(model.requests).toHaveLength(2);
  });

  test("other errors (e.g. missing credentials) are not retried", async () => {
    const model = new FakeModel([
      () => {
        throw new Anthropic.AnthropicError("Could not resolve authentication method.");
      },
    ]);
    const result = await run(await makeAgent(model), "go");
    expect(result).toMatchObject({ stopReason: "error" });
    expect(model.requests).toHaveLength(1);
  });

  test("system prompt is sent as a text block", async () => {
    const model = new FakeModel([reply("end_turn", [text("hi")])]);
    await run(await makeAgent(model), "hello");
    expect(model.requests[0]?.system).toEqual([{ type: "text", text: "sys" }]);
  });

  test("an empty system prompt is omitted (the API rejects empty text blocks)", async () => {
    const model = new FakeModel([reply("end_turn", [text("hi")])]);
    await run(await makeAgent(model, "read", undefined, ""), "hello");
    expect(model.requests[0]).not.toHaveProperty("system");
  });

  test("setModel switches later requests; params a model rejects are left out", async () => {
    const model = new FakeModel([reply("end_turn", [text("a")]), reply("end_turn", [text("b")])]);
    const agent = await makeAgent(model);
    expect(agent.model).toBe("anthropic/claude-opus-5-5");
    agent.setModel("anthropic/claude-haiku-4-5");
    await run(agent, "one");
    expect(model.requests[0]?.model).toBe("claude-haiku-4-5");
    expect(model.requests[0]).not.toHaveProperty("output_config");
    expect(model.requests[0]).not.toHaveProperty("fallbacks");
    expect(model.requests[0]).not.toHaveProperty("betas");

    agent.setModel("anthropic/claude-sonnet-5-5");
    await run(agent, "two");
    expect(model.requests[1]).toMatchObject({
      model: "claude-sonnet-5-5",
      output_config: { effort: "medium" },
      fallbacks: "default",
    });
  });

  test("setModel can switch to another provider: its client, its id, its endpoint's features", async () => {
    const official = new FakeModel([reply("end_turn", [text("a")])]);
    const proxy = new FakeModel([reply("end_turn", [text("b")])]);
    const agent = await makeAgent(
      { anthropic: official, magpie: proxy },
      "read",
      undefined,
      "sys",
      [],
      `${OPUS}[providers.magpie]\nbase_url = "http://127.0.0.1:3425"\n`,
    );
    await run(agent, "one");
    agent.setModel("magpie/codex/gpt-6-luna");
    await run(agent, "two");
    expect(official.requests.map((r) => r.model)).toEqual(["claude-opus-5-5"]);
    expect(proxy.requests[0]?.model).toBe("codex/gpt-6-luna");
    expect(proxy.requests[0]).not.toHaveProperty("fallbacks");

    expect(() => agent.setModel("nope/x")).toThrow("no [providers.nope] section");
    expect(agent.model).toBe("magpie/codex/gpt-6-luna");
  });

  test("a reply's thinking goes back only to the model that wrote it, at that endpoint", async () => {
    const thought = { type: "thinking", thinking: "hmm", signature: "sig" } as const;
    const official = new FakeModel([
      reply("end_turn", [thought, text("a")]),
      reply("end_turn", [text("c")]),
    ]);
    const proxy = new FakeModel([reply("end_turn", [text("b")])]);
    const agent = await makeAgent(
      { anthropic: official, magpie: proxy },
      "read",
      undefined,
      "sys",
      [],
      `${OPUS}[providers.magpie]\nbase_url = "http://127.0.0.1:3425"\n`,
    );
    await run(agent, "one");
    const thinkingOf = (r: ModelRequest | undefined) =>
      r?.messages.flatMap((m) =>
        typeof m.content === "string" ? [] : m.content.filter((b) => b.type === "thinking"),
      );
    // Another model, even behind one proxy, gets the reply without it...
    agent.setModel("magpie/deepseek-v4.1-flash");
    await run(agent, "two");
    expect(thinkingOf(proxy.requests[0])).toEqual([]);
    expect(proxy.requests[0]?.messages[1]).toEqual({ role: "assistant", content: [text("a")] });
    // ...the model that wrote it gets it back.
    agent.setModel("anthropic/claude-opus-5-5");
    await run(agent, "three");
    expect(thinkingOf(official.requests[1])).toEqual([thought]);
    // The session is the prompt cache key, wherever it is sent.
    expect(proxy.extras[0]).toEqual({ streamUsage: true, cacheKey: session.id });
  });

  const clock = definePlugin({
    id: "clock",
    version: "0",
    description: "",
    contextFor: (t) => `user said: ${t.userText}`,
  });
  const CTX = "<context>\n## clock\nuser said: what time is it\n</context>";
  const PROXY = `${OPUS}base_url = "http://127.0.0.1:8080"\n`;
  const HAIKU = OPUS.replace("claude-opus-5-5", "claude-haiku-4-5");

  test("context is stored apart from what the user typed", async () => {
    const model = new FakeModel([reply("end_turn", [text("ok")])]);
    await run(await makeAgent(model, "read", undefined, "sys", [clock]), "what time is it");
    expect(session.messages[0]).toEqual({ role: "user", content: "what time is it" });
    expect(session.contextOf(session.messages[0] as never)).toBe(CTX);
    const reloaded = Session.load(join(dir, "sessions"), session.id);
    expect(reloaded.contextOf(reloaded.messages[0] as never)).toBe(CTX);
  });

  test("official API + supported model: context goes in a clear_at system message", async () => {
    const model = new FakeModel([reply("end_turn", [text("ok")])]);
    await run(await makeAgent(model, "read", undefined, "sys", [clock]), "what time is it");
    expect(model.requests[0]?.messages).toEqual([
      { role: "user", content: "what time is it" },
      { role: "system", content: CTX, clear_at: "next_user_message" },
    ]);
    expect(model.requests[0]?.betas).toContain("mid-conversation-system-clear-at-2026-08-21");
  });

  test("system mode re-sends the context after each tool result of the turn", async () => {
    const model = new FakeModel([
      reply("tool_use", [toolUse("tu_1", "t__echo", { msg: "x" })]),
      reply("end_turn", [text("done")]),
    ]);
    await run(await makeAgent(model, "read", undefined, "sys", [clock]), "what time is it");
    const roles = model.requests[1]?.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "system", "assistant", "user", "system"]);
    // The first request's messages are an unchanged prefix of the second's (cache-friendly).
    expect(model.requests[1]?.messages.slice(0, 2)).toEqual(model.requests[0]?.messages as never);
  });

  test("a proxy or an older model gets a <context> text block instead", async () => {
    for (const toml of [PROXY, HAIKU]) {
      session = Session.create(join(dir, "sessions"), "m");
      const model = new FakeModel([reply("end_turn", [text("ok")])]);
      await run(await makeAgent(model, "read", undefined, "sys", [clock], toml), "what time is it");
      expect(model.requests[0]?.messages).toEqual([
        {
          role: "user",
          content: [
            { type: "text", text: CTX },
            { type: "text", text: "what time is it" },
          ],
        },
      ]);
      expect(model.requests[0]?.betas ?? []).not.toContain(
        "mid-conversation-system-clear-at-2026-08-21",
      );
    }
  });

  test("without any plugin context the user message stays a plain string", async () => {
    const model = new FakeModel([reply("end_turn", [text("ok")])]);
    await run(await makeAgent(model), "hi");
    expect(session.messages[0]).toEqual({ role: "user", content: "hi" });
  });

  const badRequest = (message: string) => () => {
    // Shaped like a real API error body; the SDK builds err.message from it.
    const body = { type: "error", error: { type: "invalid_request_error", message } };
    throw new Anthropic.BadRequestError(400, body, undefined, new Headers());
  };

  test("a 400 about system messages: downgrade to <context> blocks, retry, remember", async () => {
    const model = new FakeModel([
      badRequest("role 'system' is not supported on this model"),
      reply("end_turn", [text("ok")]),
      reply("end_turn", [text("again")]),
    ]);
    const agent = await makeAgent(model, "read", undefined, "sys", [clock]);
    const result = await run(agent, "what time is it");
    expect(result.stopReason).toBe("end_turn");
    expect(model.requests[0]?.messages.some((m) => m.role === "system")).toBe(true);
    expect(model.requests[1]?.messages.some((m) => m.role === "system")).toBe(false);
    expect(events).toContainEqual({
      type: "notice",
      text: "anthropic/claude-opus-5-5 doesn't support mid-conversation system messages here; continuing without it.",
    });
    // Remembered: the next turn goes straight to blocks, even for a fresh agent.
    const fresh = await makeAgent(model, "read", undefined, "sys", [clock]);
    await run(fresh, "and now?");
    expect(model.requests[2]?.messages.some((m) => m.role === "system")).toBe(false);
  });

  test("a model that refuses images: a line in place of each from then on, the session keeping them", async () => {
    const name = saveUpload(join(dir, "uploads"), PNG, "image/png");
    claimUploads(join(dir, "uploads"), session.imagesDir, [name]);
    const model = new FakeModel([
      badRequest("messages.0.content.0: image_url is not supported by this model"),
      reply("end_turn", [text("a text-only answer")]),
      reply("end_turn", [text("still none")]),
    ]);
    const agent = await makeAgent(model);
    await agent.runTurn(
      session,
      { text: "what is this?", images: [name] },
      {
        signal: new AbortController().signal,
        onEvent: (e) => events.push(e),
        confirm: async () => "once",
      },
    );
    const blocks = (r: ModelRequest | undefined) =>
      r?.messages.flatMap((m) => (typeof m.content === "string" ? [] : m.content)) ?? [];
    expect(blocks(model.requests[0]).some((b) => b.type === "image")).toBe(true);
    expect(blocks(model.requests[1]).some((b) => b.type === "image")).toBe(false);
    expect(blocks(model.requests[1])).toContainEqual({
      type: "text",
      text: "[An image was left out: this model takes none]",
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "notice", text: expect.stringContaining("images") }),
    );
    // The session keeps the image; the next turn leaves it out too, without asking again.
    expect(session.messages[0]?.content).toContainEqual(expect.objectContaining({ type: "image" }));
    await run(agent, "and now?");
    expect(blocks(model.requests[2]).some((b) => b.type === "image")).toBe(false);
  });

  test("a 400 about fallbacks or effort drops just that parameter", async () => {
    const model = new FakeModel([
      badRequest("fallbacks: unknown field"),
      badRequest("output_config.effort: not supported for this model"),
      reply("end_turn", [text("ok")]),
    ]);
    await run(await makeAgent(model), "hi");
    expect(model.requests[0]).toHaveProperty("fallbacks");
    expect(model.requests[1]).not.toHaveProperty("fallbacks");
    expect(model.requests[1]).toHaveProperty("output_config");
    expect(model.requests[2]).not.toHaveProperty("output_config");
    expect(events.filter((e) => e.type === "notice")).toHaveLength(2);
  });

  test("a server-side refusal fallback is reported as a notice", async () => {
    const fallback = {
      type: "fallback",
      from: { model: "claude-opus-5-5" },
      to: { model: "claude-opus-4-8" },
      trigger: { type: "refusal" },
    } as unknown as Block;
    const model = new FakeModel([reply("end_turn", [fallback, text("here you go")])]);
    const result = await run(await makeAgent(model), "a borderline question");
    expect(result.stopReason).toBe("end_turn");
    expect(events).toContainEqual({
      type: "notice",
      text: "claude-opus-5-5 declined this request; claude-opus-4-8 answered instead.",
    });
  });

  test("an unrelated 400 is a normal error, not a retry", async () => {
    const model = new FakeModel([badRequest("messages: text content blocks must be non-empty")]);
    const result = await run(await makeAgent(model), "hi");
    expect(result).toMatchObject({ stopReason: "error" });
    expect(model.requests).toHaveLength(1);
  });

  test("verbose events: context once per turn, request info before each call, served-by model", async () => {
    const model = new FakeModel([
      reply("tool_use", [toolUse("tu_1", "t__echo", { msg: "x" })]),
      reply("end_turn", [text("done")]),
    ]);
    await run(await makeAgent(model, "read", undefined, "sys", [clock]), "what time is it");
    expect(events.filter((e) => e.type === "context")).toEqual([{ type: "context", text: CTX }]);
    const requests = events.filter((e) => e.type === "request");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      step: 1,
      info: {
        model: "claude-opus-5-5",
        effort: { configured: "medium", sent: "medium" },
        contextMode: "system",
        messages: 2,
        tools: 1,
        maxTokens: 64000,
      },
    });
    expect(events.find((e) => e.type === "step")).toMatchObject({ model: "claude-opus-5-5" });
  });

  test("request uses caching, effort and fallbacks from config", async () => {
    const model = new FakeModel([reply("end_turn", [text("hi")])]);
    await run(await makeAgent(model), "hello");
    expect(model.requests[0]).toMatchObject({
      model: "claude-opus-5-5",
      cache_control: { type: "ephemeral" },
      output_config: { effort: "medium" },
      fallbacks: "default",
      betas: ["server-side-fallback-2026-07-01"],
    });
  });

  test("outside content taints the turn from the next step, and tools may ask then", async () => {
    const seen: boolean[] = [];
    const turns: number[] = [];
    const asked: ToolCallRequest[] = [];
    const model = new FakeModel([
      // Written before the page was read: runs as before, unasked.
      reply("tool_use", [toolUse("tu_1", "w__page"), toolUse("tu_2", "w__note")]),
      reply("tool_use", [toolUse("tu_3", "w__note")]),
      reply("end_turn", [text("the page says so")]),
    ]);
    const agent = await makeAgent(
      model,
      "read",
      async (c) => {
        asked.push(c);
        return "always";
      },
      "sys",
      [outsidePlugin(seen, turns)],
    );
    expect(session.tainted).toBe(false);
    await run(agent, "go");
    expect(seen).toEqual([false, true]);
    // Asked every time: "always" adds no rule.
    expect(asked).toMatchObject([
      { name: "w__note", reason: "read outside content", canRemember: false },
    ]);
    expect(readFileSync(join(dir, "config.toml"), "utf8")).not.toContain("w__note");
    expect(session.tainted).toBe(true);
    expect(Session.load(join(dir, "sessions"), session.id).tainted).toBe(true);

    // The user speaking again ends it: the next turn writes unasked.
    model.script.push(
      reply("tool_use", [toolUse("tu_4", "w__note")]),
      reply("end_turn", [text("noted, and on to dinner")]),
    );
    await run(agent, "anyway, what should I cook?");
    expect(seen).toEqual([false, true, false]);
    expect(turns).toEqual([1, 1, 2]);
    expect(asked).toHaveLength(1);
    expect(session.tainted).toBe(false);
    expect(Session.load(join(dir, "sessions"), session.id).tainted).toBe(false);
    // Ivy's reply in the turn that read the page may repeat it; others may not.
    const history = sessionHistory(join(dir, "sessions")).messages(session.id);
    expect(history).toMatchObject([
      { role: "user", text: "go" },
      { role: "assistant", text: "the page says so", outside: true },
      { role: "user", text: "anyway, what should I cook?" },
      { role: "assistant", text: "noted, and on to dinner" },
    ]);
    expect(history[3]?.outside).toBeUndefined();
  });

  test("the vendor's search: offered, shown, and tainting the reply that ran it", async () => {
    const seen: boolean[] = [];
    const asked: ToolCallRequest[] = [];
    const web = definePlugin({
      id: "web",
      version: "0",
      description: "web",
      serverTools: ["web_search"],
    });
    const model = new FakeModel([
      // The note is written after the results, in the same reply: it is asked.
      reply("tool_use", [...search("srv_1", "finale date"), toolUse("tu_1", "w__note")]),
      reply("end_turn", [text("It airs Friday.")]),
    ]);
    const agent = await makeAgent(
      model,
      "read",
      async (c) => {
        asked.push(c);
        return "once";
      },
      "sys",
      [outsidePlugin(seen), web],
    );
    await run(agent, "when is the finale?");
    expect(model.requests[0]?.tools?.at(-1)).toEqual({
      type: "web_search_20260209",
      name: "web_search",
      max_uses: 5,
    });
    expect(events.filter((e) => e.type === "tool_call" || e.type === "tool_result")).toMatchObject([
      { type: "tool_call", id: "srv_1", name: "web_search", input: { query: "finale date" } },
      { type: "tool_result", id: "srv_1", content: "Finale — https://a.example/f", isError: false },
      { type: "tool_call", id: "tu_1", name: "w__note" },
      { type: "tool_result", id: "tu_1" },
    ]);
    expect(asked).toMatchObject([{ name: "w__note" }]);
    expect(seen).toEqual([true]);
    expect(sessionHistory(join(dir, "sessions")).messages(session.id).at(-1)).toMatchObject({
      text: "It airs Friday.",
      outside: true,
    });
  });

  test("addresses the user wrote or a search returned, this reply's own included, go unasked", async () => {
    const asked: ToolCallRequest[] = [];
    const web = definePlugin({
      id: "web",
      version: "0",
      description: "web",
      serverTools: ["web_search"],
      tools: [
        defineTool({
          name: "fetch",
          description: "fetch",
          input: z.object({ url: z.string() }),
          risk: "read",
          askFirst: (i, { urls }) => (urls.has(i.url) ? undefined : "unnamed"),
          run: () => "page",
        }),
      ],
    });
    const model = new FakeModel([
      reply("tool_use", [
        ...search("srv_1", "finale"),
        toolUse("tu_1", "web__fetch", { url: "https://a.example/f" }),
        toolUse("tu_2", "web__fetch", { url: "https://user.example/page" }),
        toolUse("tu_3", "web__fetch", { url: "https://made.up/?d=secret" }),
      ]),
      reply("end_turn", [text("ok")]),
    ]);
    const agent = await makeAgent(
      model,
      "read",
      async (c) => {
        asked.push(c);
        return "deny";
      },
      "sys",
      [web],
    );
    await run(agent, "see https://user.example/page and look up the finale");
    expect(asked.map((c) => (c.input as { url: string }).url)).toEqual([
      "https://made.up/?d=secret",
    ]);
  });

  test("a model without the search tool gets the replies without its blocks", async () => {
    const model = new FakeModel([reply("end_turn", [text("ok")])]);
    session.append(
      { role: "user", content: "when is the finale?" },
      {
        role: "assistant",
        content: [
          ...search("srv_1", "finale"),
          { type: "text", text: "Friday.", citations: [{ type: "web_search_result_location" }] },
        ] as unknown as Block[],
      },
    );
    // No web plugin: no search tool, so the history can't hold its blocks.
    await run(await makeAgent(model), "thanks");
    expect(model.requests[0]?.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Friday." }],
    });
  });

  test("a deny rule still wins over a tool's own ask", async () => {
    const seen: boolean[] = [];
    let asked = 0;
    const model = new FakeModel([
      reply("tool_use", [toolUse("tu_1", "w__page")]),
      reply("tool_use", [toolUse("tu_2", "w__note")]),
      reply("end_turn", [text("ok")]),
    ]);
    const agent = await makeAgent(
      model,
      "read",
      async () => {
        asked++;
        return "once";
      },
      "sys",
      [outsidePlugin(seen)],
      OPUS,
      '[permissions]\ndeny = ["w__note"]\n',
    );
    await run(agent, "go");
    expect(asked).toBe(0);
    expect(seen).toEqual([]);
  });
});
