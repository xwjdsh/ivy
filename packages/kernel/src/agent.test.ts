import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { definePlugin, defineTool, type IvyPlugin, type RiskLevel } from "@ivy/plugin-api";
import { z } from "zod";
import { Agent, type AgentEvent, type ToolCallRequest } from "./agent.ts";
import { Capabilities } from "./capabilities.ts";
import { loadConfig, resolvePaths } from "./config.ts";
import {
  isOfficialAnthropicApi,
  type ModelClient,
  type ModelMessage,
  type ModelRequest,
} from "./model.ts";
import { type PermissionChoice, Permissions } from "./permissions.ts";
import { PluginHost } from "./plugins.ts";
import { Session } from "./session.ts";

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
  constructor(private readonly script: Array<ModelMessage | (() => never)>) {}

  async stream(request: ModelRequest, handlers: { onText?(d: string): void }) {
    this.requests.push(request);
    const next = this.script.shift();
    if (!next) throw new Error("script exhausted");
    if (typeof next === "function") next();
    const message = next as ModelMessage;
    for (const b of message.content) if (b.type === "text") handlers.onText?.(b.text);
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

  async function makeAgent(
    model: ModelClient,
    risk: RiskLevel = "read",
    confirm: (c: ToolCallRequest) => Promise<PermissionChoice> = async () => "once",
    systemPrompt = "sys",
    extraPlugins: IvyPlugin[] = [],
    providerToml = 'default_model = "claude-opus-5-5"\n',
    extraToml = "",
  ) {
    const paths = resolvePaths(dir);
    writeFileSync(paths.config, `[providers.anthropic]\n${providerToml}${extraToml}`);
    const plugins = new PluginHost(paths.data, {});
    await plugins.register(testPlugin(risk));
    for (const p of extraPlugins) await plugins.register(p);
    const config = loadConfig(paths);
    const p = config.activeProvider;
    const capabilities = new Capabilities(
      join(dir, "cache", "models.json"),
      p.base_url,
      isOfficialAnthropicApi(p.base_url),
      { effort: config.generation.effort, refusalFallback: p.refusal_fallback },
    );
    const permissions = new Permissions(config.permissions, join(dir, "permissions.json"), (tool) =>
      plugins.isDefaultAllowed(tool),
    );
    return new Agent({ config, model, plugins, systemPrompt, confirm, capabilities, permissions });
  }

  const run = (agent: Agent, input: string, signal = new AbortController().signal) =>
    agent.runTurn(session, input, { signal, onEvent: (e) => events.push(e) });

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
      { name: "t__echo", input: { msg: "x" }, risk: "read", canRemember: true },
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
    session = Session.create(join(dir, "sessions"), "m");
    await run(await makeAgent(new FakeModel(script()), "write", confirm), "go again");
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
    expect(agent.model).toBe("claude-opus-5-5");
    agent.setModel("claude-haiku-4-5");
    await run(agent, "one");
    expect(model.requests[0]?.model).toBe("claude-haiku-4-5");
    expect(model.requests[0]).not.toHaveProperty("output_config");
    expect(model.requests[0]).not.toHaveProperty("fallbacks");
    expect(model.requests[0]).not.toHaveProperty("betas");

    agent.setModel("claude-sonnet-5-5");
    await run(agent, "two");
    expect(model.requests[1]).toMatchObject({
      model: "claude-sonnet-5-5",
      output_config: { effort: "medium" },
      fallbacks: "default",
    });
  });

  const clock = definePlugin({
    id: "clock",
    version: "0",
    description: "",
    contextFor: (t) => `user said: ${t.userText}`,
  });
  const CTX = "<context>\n## clock\nuser said: what time is it\n</context>";
  const PROXY = 'default_model = "claude-opus-5-5"\nbase_url = "http://127.0.0.1:8080"\n';

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
    for (const providerToml of [PROXY, 'default_model = "claude-haiku-4-5"\n']) {
      session = Session.create(join(dir, "sessions"), "m");
      const model = new FakeModel([reply("end_turn", [text("ok")])]);
      await run(
        await makeAgent(model, "read", undefined, "sys", [clock], providerToml),
        "what time is it",
      );
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
      text: "claude-opus-5-5 doesn't support mid-conversation system messages here; continuing without it.",
    });
    // Remembered: the next turn goes straight to blocks, even for a fresh agent.
    const fresh = await makeAgent(model, "read", undefined, "sys", [clock]);
    await run(fresh, "and now?");
    expect(model.requests[2]?.messages.some((m) => m.role === "system")).toBe(false);
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
});
