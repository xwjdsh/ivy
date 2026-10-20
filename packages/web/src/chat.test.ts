import { expect, test } from "bun:test";
import type { SessionChange, SessionView } from "@ivy/protocol";
import { apply, chatOf, emptyChat } from "./chat.ts";

const label = { plugin: "memory", text: "save: Dentist" };
const prompt = { id: "p1", text: "Remember the dentist" };
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };

const run = (events: SessionChange[], chat = emptyChat("s1")) => events.reduce(apply, chat);

test("a turn: the prompt, text around a tool call, and the end", () => {
  const chat = run([
    { type: "prompt", prompt },
    { type: "turn_start", prompt },
    { type: "text", delta: "Saving " },
    { type: "text", delta: "it." },
    { type: "tool_call", id: "t1", name: "memory__save", label, input: { text: "Dentist" } },
    { type: "tool_result", id: "t1", name: "memory__save", label, content: "ok", isError: false },
    { type: "text", delta: "Done." },
    { type: "step", step: 1, model: "m", stopReason: "end_turn", usage, costUsd: 0, latencyMs: 1 },
    { type: "turn_end", promptId: "p1", end: { stopReason: "end_turn", steps: 1, costUsd: 0 } },
  ]);
  expect(chat.items).toEqual([
    { kind: "user", text: "Remember the dentist" },
    { kind: "assistant", markdown: "Saving it." },
    {
      kind: "tool",
      id: "t1",
      name: "memory__save",
      label,
      input: { text: "Dentist" },
      result: "ok",
      isError: false,
      running: false,
    },
    { kind: "assistant", markdown: "Done." },
  ]);
  expect(chat).toMatchObject({ queue: [], streaming: "", running: undefined });
  expect(chat.tokens).toEqual({ in: 10, cached: 0, out: 5 });
});

test("a turn that failed says why", () => {
  const chat = run([
    { type: "turn_start", prompt },
    {
      type: "turn_end",
      promptId: "p1",
      end: { stopReason: "error", steps: 0, costUsd: 0, error: "endpoint down" },
    },
  ]);
  expect(chat.items.at(-1)).toEqual({ kind: "note", text: "Error: endpoint down", tone: "error" });
});

test("joining a turn that runs keeps streaming into its text", () => {
  const view: SessionView = {
    id: "s1",
    entries: [{ kind: "user", text: prompt.text }],
    streaming: "Half a",
    running: prompt,
    queue: [{ id: "p2", text: "next" }],
    tokens: { in: 0, cached: 0, out: 0 },
  };
  const chat = run([{ type: "text", delta: " reply" }], chatOf(view));
  expect(chat.streaming).toBe("Half a reply");
  expect(run([{ type: "prompt_withdrawn", promptId: "p2" }], chat).queue).toEqual([]);
});

test("a permission prompt goes once some client answered it", () => {
  const ask = {
    id: "a1",
    sessionId: "s1",
    name: "memory__save",
    label,
    input: {},
    risk: "write" as const,
    reason: "write tool",
    choices: ["once" as const, "deny" as const],
  };
  const asked = run([{ type: "permission", ask }]);
  expect(asked.permission).toEqual(ask);
  expect(
    run([{ type: "permission_answered", id: "other", choice: "once" }], asked).permission,
  ).toEqual(ask);
  expect(
    run([{ type: "permission_answered", id: "a1", choice: "deny" }], asked).permission,
  ).toBeUndefined();
});
