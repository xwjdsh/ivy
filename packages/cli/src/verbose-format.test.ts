import { expect, test } from "bun:test";
import { formatRequest, formatStep } from "./verbose-format.ts";

const info = {
  model: "claude-opus-5-5",
  effort: { configured: "xhigh", sent: "high" },
  contextMode: "system" as const,
  betas: ["server-side-fallback-2026-07-01"],
  messages: 3,
  tools: 2,
  maxTokens: 64000,
  hasContext: false,
};

test("request line: step, message and tool counts, and context only when there is some", () => {
  expect(formatRequest(1, info)).toBe("→ step 1 · 3 msgs · 2 tools");
  expect(formatRequest(2, { ...info, hasContext: true })).toBe(
    "→ step 2 · 3 msgs · 2 tools · context system",
  );
});

test("step line shows stop reason, tokens, cost, time, fallback model and trace", () => {
  const step = {
    type: "step" as const,
    step: 1,
    model: "claude-opus-4-8",
    stopReason: "end_turn",
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 0,
    },
    costUsd: 0.0012,
    latencyMs: 1300,
    traceFile: "/t/1.json",
  } as never;
  expect(formatStep(step, "claude-opus-5-5")).toBe(
    "← step 1 · end_turn · in 10 out 5 · cache read 100 write 0 · 1.3s · served by claude-opus-4-8\n  trace: /t/1.json",
  );
});

test("a proxy dropping the routing prefix is not reported as a different model", () => {
  const step = {
    type: "step" as const,
    step: 1,
    model: "qfmodel",
    stopReason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
    costUsd: null,
    latencyMs: 0,
  } as never;
  expect(formatStep(step, "qoder/qfmodel")).not.toContain("served by");
  expect(formatStep(step, "qoder/other")).toContain("served by qfmodel");
});
