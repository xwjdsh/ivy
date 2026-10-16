import { expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { contextBlock, promptText, renderMessages } from "./turn-context.ts";

type M = Anthropic.Beta.BetaMessageParam;
const user = (content: string): M => ({ role: "user", content });
const assistant = (content: string): M => ({ role: "assistant", content });

test("contextBlock wraps sections; nothing gives an empty string", () => {
  expect(contextBlock([{ id: "a", text: "x" }])).toBe("<context>\n## a\nx\n</context>");
  expect(contextBlock([])).toBe("");
});

test("system mode: each turn's context follows its prompt; turns without context get none", () => {
  const p1 = user("q1");
  const p2 = user("q2");
  const history = [p1, assistant("a1"), p2, assistant("a2")];
  const ctx = new Map([[p1, "C1"]]);
  expect(renderMessages(history, (m) => ctx.get(m), "system")).toEqual([
    p1,
    { role: "system", content: "C1", clear_at: "next_user_message" },
    assistant("a1"),
    p2,
    assistant("a2"),
  ]);
});

test("system mode: an interrupted turn (user right after user) gets no system message", () => {
  const p1 = user("interrupted");
  const p2 = user("again");
  const ctx = new Map([
    [p1, "C1"],
    [p2, "C2"],
  ]);
  expect(renderMessages([p1, p2], (m) => ctx.get(m), "system")).toEqual([
    p1,
    p2,
    { role: "system", content: "C2", clear_at: "next_user_message" },
  ]);
});

test("rendering is deterministic and grows append-only as the turn goes on", () => {
  const p1 = user("q1");
  const ctx = new Map([[p1, "C1"]]);
  const first = renderMessages([p1], (m) => ctx.get(m), "system");
  const later = renderMessages([p1, assistant("a1")], (m) => ctx.get(m), "system");
  expect(later.slice(0, first.length)).toEqual(first);
  expect(renderMessages([p1], (m) => ctx.get(m), "system")).toEqual(first);
});

test("block mode puts the context before the text and leaves other messages alone", () => {
  const p1 = user("q1");
  const ctx = new Map([[p1, "C1"]]);
  expect(renderMessages([p1, assistant("a1")], (m) => ctx.get(m), "block")).toEqual([
    {
      role: "user",
      content: [
        { type: "text", text: "C1" },
        { type: "text", text: "q1" },
      ],
    },
    assistant("a1"),
  ]);
});

test("promptText: typed text only; tool results are not prompts", () => {
  expect(promptText(user("hi"))).toBe("hi");
  expect(
    promptText({
      role: "user",
      content: [
        { type: "text", text: "<context>\nx\n</context>" },
        { type: "text", text: "hi" },
      ],
    }),
  ).toBe("hi");
  expect(
    promptText({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t", content: "r" }],
    }),
  ).toBeNull();
  expect(promptText(assistant("a"))).toBeNull();
});
