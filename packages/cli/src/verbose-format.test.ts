import { expect, test } from "bun:test";
import { formatCall } from "./verbose-format.ts";

const request = {
  model: "claude-opus-5-5",
  effort: { configured: "high", sent: "high" },
  contextMode: "system" as const,
  betas: [],
  messages: 3,
  tools: 2,
  maxTokens: 64000,
  hasContext: false,
};

const step = (over: Record<string, unknown> = {}) =>
  ({
    type: "step",
    step: 1,
    model: "claude-opus-5-5",
    stopReason: "end_turn",
    usage: {
      input_tokens: 50,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    costUsd: 0.0012,
    latencyMs: 1500,
    ...over,
  }) as never;

test("one line per call: step, msgs, stop reason, tokens, time; no money", () => {
  expect(formatCall(step(), request)).toBe("step 1 · 3 msgs · end_turn · in 50 out 20 · 1.5s");
});

test("cache numbers appear only when there are any", () => {
  const cached = step({
    usage: {
      input_tokens: 12,
      output_tokens: 20,
      cache_read_input_tokens: 3200,
      cache_creation_input_tokens: 120,
    },
  });
  expect(formatCall(cached, request)).toContain("· cache read 3.2k write 120 ·");
});

test("context mode only when the turn has context; trace on its own line", () => {
  expect(formatCall(step({ traceFile: "/t/1.json" }), { ...request, hasContext: true })).toBe(
    "step 1 · 3 msgs · context system · end_turn · in 50 out 20 · 1.5s\n  trace: /t/1.json",
  );
});

test("served by: a real switch is shown, a proxy dropping the routing prefix is not", () => {
  expect(formatCall(step({ model: "claude-opus-4-8" }), request)).toContain(
    "served by claude-opus-4-8",
  );
  const proxied = { ...request, model: "qoder/qfmodel" };
  expect(formatCall(step({ model: "qfmodel" }), proxied)).not.toContain("served by");
  expect(formatCall(step({ model: "qfmodel" }), { ...request, model: "qoder/other" })).toContain(
    "served by qfmodel",
  );
});
