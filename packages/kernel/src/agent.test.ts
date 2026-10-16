import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { definePlugin, defineTool, type RiskLevel } from "@ivy/plugin-api";
import { z } from "zod";
import { Agent, type AgentEvent, type ToolCallRequest } from "./agent.ts";
import { loadConfig, resolvePaths } from "./config.ts";
import type { ModelClient, ModelMessage, ModelRequest } from "./model.ts";
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
    confirm: (c: ToolCallRequest) => Promise<boolean> = async () => true,
    systemPrompt = "sys",
  ) {
    const paths = resolvePaths(dir);
    const plugins = new PluginHost(paths.data, {});
    await plugins.register(testPlugin(risk));
    return new Agent({ config: loadConfig(paths), model, plugins, systemPrompt, confirm });
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

  test("risky tools ask for confirmation and denial is reported to Claude", async () => {
    const asked: ToolCallRequest[] = [];
    const model = new FakeModel([
      reply("tool_use", [toolUse("tu_1", "t__echo", { msg: "x" })]),
      reply("end_turn", [text("ok")]),
    ]);
    const agent = await makeAgent(model, "external", async (c) => {
      asked.push(c);
      return false;
    });
    await run(agent, "go");
    expect(asked).toHaveLength(1);
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({
      content: "The user denied this tool call.",
      isError: true,
    });
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
