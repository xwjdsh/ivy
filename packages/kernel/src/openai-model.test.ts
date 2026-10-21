import { expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";
import type { ModelRequest } from "./model.ts";
import {
  asAnthropicError,
  keepErrorText,
  ReplyBuilder,
  toChatRequest,
  usageOf,
} from "./openai-model.ts";

const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: "deepseek-v4.1-flash",
  max_tokens: 1000,
  system: [{ type: "text", text: "You are Ivy." }],
  tools: [{ name: "t__weather", description: "Weather", input_schema: { type: "object" } }],
  messages: [
    { role: "user", content: "earlier" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "old thought", signature: "" },
        { type: "text", text: "earlier answer" },
      ],
    },
    {
      role: "user",
      content: [
        { type: "text", text: "<context>" },
        { type: "text", text: "Weather?" },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "use the tool", signature: "" },
        { type: "tool_use", id: "call_1", name: "t__weather", input: { city: "Tokyo" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "Sunny" }] },
  ],
  output_config: { effort: "low" },
  cache_control: { type: "ephemeral" },
  ...over,
});

test("a compatible endpoint gets the plainest request: system role, max_tokens", () => {
  const params = toChatRequest(request(), {}, false);
  expect(params.messages[0]).toEqual({ role: "system", content: "You are Ivy." });
  expect(params.max_tokens).toBe(1000);
  expect(params.max_completion_tokens).toBeUndefined();
  expect(params.stream).toBe(true);
  expect(params.reasoning_effort).toBe("low");
  expect(params.tools).toEqual([
    {
      type: "function",
      function: { name: "t__weather", description: "Weather", parameters: { type: "object" } },
    },
  ]);
});

test("OpenAI's own API gets what is its alone: the developer role, max_completion_tokens", () => {
  const params = toChatRequest(request(), { streamUsage: true, cacheKey: "s1" }, true);
  expect(params.messages[0]).toEqual({ role: "developer", content: "You are Ivy." });
  expect(params.max_completion_tokens).toBe(1000);
  expect(params.max_tokens).toBeUndefined();
  expect(params.stream_options).toEqual({ include_usage: true });
  expect(params.prompt_cache_key).toBe("s1");
});

test("tool calls and results translate, and reasoning goes back only within the turn", () => {
  const { messages } = toChatRequest(request(), {}, false);
  // An earlier turn's reasoning stays behind; this turn's goes with its tool call.
  expect(messages[2]).toEqual({ role: "assistant", content: "earlier answer" });
  expect(messages[3]).toEqual({
    role: "user",
    content: [
      { type: "text", text: "<context>" },
      { type: "text", text: "Weather?" },
    ],
  });
  // reasoning_content is DeepSeek's, not in the SDK's types.
  expect(messages[4] as unknown).toEqual({
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "t__weather", arguments: '{"city":"Tokyo"}' },
      },
    ],
    reasoning_content: "use the tool",
  });
  expect(messages[5]).toEqual({ role: "tool", tool_call_id: "call_1", content: "Sunny" });
  expect(messages).toHaveLength(6);
});

test("a tool result's image follows it in a user message, as only text goes in a tool result", () => {
  const { messages } = toChatRequest(
    request({
      messages: [
        { role: "user", content: "look" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "c", name: "t__weather", input: {} }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "c",
              content: [
                { type: "text", text: "a chart" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
              ],
            },
          ],
        },
      ],
    }),
    {},
    false,
  );
  expect(messages.at(-2)).toEqual({ role: "tool", tool_call_id: "c", content: "a chart" });
  expect(messages.at(-1)).toEqual({
    role: "user",
    content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }],
  });
});

const chunk = (delta: object, extra: object = {}): ChatCompletionChunk =>
  ({
    id: "chatcmpl-1",
    model: "deepseek-v4.1-flash",
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra,
  }) as ChatCompletionChunk;

test("a streamed reply comes together: reasoning, text, tool calls in pieces, usage", () => {
  const texts: string[] = [];
  const reply = new ReplyBuilder("asked", { onText: (d) => texts.push(d) });
  // As magpie streams them: reasoning first, then a tool call in many pieces by index.
  reply.add(chunk({ role: "assistant", reasoning_content: "need " }));
  reply.add(chunk({ reasoning_content: "the weather" }));
  reply.add(chunk({ content: "Checking." }));
  reply.add(
    chunk({
      tool_calls: [{ index: 0, id: "call_00_x", function: { name: "weather", arguments: "" } }],
    }),
  );
  for (const piece of ['{"', "city", '":"', "Tokyo", '"}']) {
    reply.add(chunk({ tool_calls: [{ index: 0, function: { arguments: piece } }] }));
  }
  reply.add({
    ...chunk({}),
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  } as ChatCompletionChunk);
  reply.add({
    id: "chatcmpl-1",
    choices: [],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 60 },
    },
  } as unknown as ChatCompletionChunk);
  const message = reply.finish();
  expect(texts).toEqual(["Checking."]);
  expect(message.model).toBe("deepseek-v4.1-flash");
  expect(message.stop_reason).toBe("tool_use");
  expect(message.content).toEqual([
    { type: "thinking", thinking: "need the weather", signature: "" },
    { type: "text", text: "Checking.", citations: null },
    { type: "tool_use", id: "call_00_x", name: "weather", input: { city: "Tokyo" } },
  ] as never);
  expect(message.usage).toMatchObject({
    input_tokens: 40,
    cache_read_input_tokens: 60,
    output_tokens: 20,
  });
});

test("a reply without a finish reason is told by what it holds; unparseable tool input is retried as on the Messages API", () => {
  const plain = new ReplyBuilder("m", {});
  plain.add(chunk({ content: "hi" }));
  expect(plain.finish().stop_reason).toBe("end_turn");

  const broken = new ReplyBuilder("m", {});
  broken.add(
    chunk({ tool_calls: [{ index: 0, id: "c", function: { name: "t", arguments: '{"a":' } }] }),
  );
  expect(() => broken.finish()).toThrow(/^Unable to parse tool parameter JSON/);
});

test("usage is counted as Anthropic counts it: input without the cached tokens", () => {
  expect(usageOf({ prompt_tokens: 17, completion_tokens: 1, total_tokens: 18 })).toMatchObject({
    input_tokens: 17,
    cache_read_input_tokens: 0,
    output_tokens: 1,
  });
  expect(usageOf(undefined)).toMatchObject({ input_tokens: 0, output_tokens: 0 });
});

test("OpenAI SDK errors come out as the Anthropic SDK's, so the loop treats both protocols alike", () => {
  const body = { error: { message: "Unrecognized request argument supplied: prompt_cache_key" } };
  const err = asAnthropicError(OpenAI.APIError.generate(400, body, undefined, new Headers()));
  expect(err).toBeInstanceOf(Anthropic.BadRequestError);
  expect((err as Error).message).toContain("prompt_cache_key");
  expect(
    asAnthropicError(new OpenAI.APIConnectionError({ message: "Connection error." })),
  ).toBeInstanceOf(Anthropic.APIConnectionError);
});

test("an error body the SDK wouldn't read is kept: FastAPI's detail, plain text", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/detail")
        return Response.json(
          { detail: "Extra inputs are not permitted: stream_options" },
          { status: 400 },
        );
      if (path === "/text") return new Response("bad field reasoning_effort", { status: 400 });
      return Response.json({ error: { message: "kept as it is" } }, { status: 400 });
    },
  });
  try {
    const bodyOf = async (path: string) =>
      (await (await keepErrorText(`http://localhost:${server.port}${path}`)).json()) as {
        error: { message: string };
      };
    expect((await bodyOf("/detail")).error.message).toContain("stream_options");
    expect((await bodyOf("/text")).error.message).toBe("bad field reasoning_effort");
    expect((await bodyOf("/openai")).error.message).toBe("kept as it is");
  } finally {
    server.stop(true);
  }
});
