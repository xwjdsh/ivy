import { expect, test } from "bun:test";
import type { SessionChange, SessionView } from "@ivy/protocol";
import { apply, arrange, chatOf, emptyChat, type Item, thinking } from "./chat.ts";

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

/** A finished call: one that brought in outside content, one on Ivy's own records or journal, or another. */
const tool = (
  id: string,
  is?: "outside" | "records" | "journal",
  { isError = false, running = false } = {},
): Item => ({
  kind: "tool",
  id,
  name: id,
  label: {
    plugin: id,
    text: "",
    ...((is === "records" || is === "journal") && { own: is }),
  },
  input: {},
  result: "",
  isError,
  ...(is === "outside" && { outside: true }),
  ...(running && { running }),
});

const shape = (shown: ReturnType<typeof arrange>) =>
  shown.map((s) =>
    "item" in s
      ? `${s.item.kind}@${s.at}`
      : `marks:${s.sources.map((t) => t.id).join("+")}|${s.aside.map((t) => t.id).join("+")}@${s.at}`,
  );

test("under her reply, where her words came from and her own bookkeeping, apart; what failed or acts stays a line", () => {
  const items: Item[] = [
    { kind: "user", text: "下周二看牙" },
    tool("search", "outside"),
    tool("memory", "records"),
    tool("journal", "journal"),
    tool("send"),
    { kind: "assistant", markdown: "记下了" },
    tool("broken", "records", { isError: true }),
    tool("late", "records"),
    { kind: "user", text: "谢谢" },
  ];
  expect(shape(arrange(items))).toEqual([
    "user@0",
    "tool@4",
    "assistant@5",
    "marks:search|memory+journal@1",
    "tool@6",
    "marks:|late@7",
    "user@8",
  ]);
});

test("while a turn runs: a search is a line, marks wait for the reply; her running bookkeeping is thinking", () => {
  const items: Item[] = [
    { kind: "user", text: "hi" },
    tool("memory", "records"),
    // Running, what a call brings in isn't known yet.
    tool("search", undefined, { running: true }),
  ];
  expect(shape(arrange(items, true))).toEqual(["user@0", "tool@2"]);
  // Done, a search stays a line until the reply it goes under.
  const done = [...items.slice(0, 2), tool("search", "outside")];
  expect(shape(arrange(done, true))).toEqual(["user@0", "tool@2"]);
  expect(shape(arrange([...done, { kind: "assistant", markdown: "ok" }], true))).toEqual([
    "user@0",
    "assistant@3",
    "marks:search|memory@1",
  ]);
  expect(shape(arrange(items.slice(0, 2), false))).toEqual(["user@0", "marks:|memory@1"]);
  // A later line doesn't push a finished search below it.
  const later = [...done, tool("send", undefined, { running: true })];
  expect(shape(arrange(later, true))).toEqual(["user@0", "tool@2", "tool@3"]);
  // Her own records stay hers, even when what they gave back counts as outside.
  const recall: Item = { ...tool("recall", "records"), outside: true } as Item;
  const recalling = { ...recall, running: true } as Item;
  expect(shape(arrange([items[0] as Item, recalling], true))).toEqual(["user@0"]);
  expect(shape(arrange([items[0] as Item, recall]))).toEqual(["user@0", "marks:|recall@1"]);
  const chat = { ...emptyChat("s"), running: { id: "p", text: "hi" } };
  expect(thinking({ ...chat, items: [tool("memory", "records", { running: true })] })).toBe(true);
  expect(thinking({ ...chat, items: [tool("search", undefined, { running: true })] })).toBe(false);
});
