import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "./session.ts";

test("sessions persist, reload and list newest first", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ivy-sessions-"));
  const a = Session.create(dir, "m");
  a.append({ role: "user", content: "first question" }, { role: "assistant", content: "answer" });
  a.recordUsage({ input_tokens: 1, output_tokens: 1 } as never, 0.01);

  await Bun.sleep(5);
  const b = Session.create(dir, "m");
  b.append({ role: "user", content: "second" });

  const loaded = Session.load(dir, a.id);
  expect(loaded.messages).toEqual(a.messages);

  const list = Session.list(dir);
  expect(list.map((s) => s.id)).toEqual([b.id, a.id]);
  expect(list[1]).toMatchObject({ preview: "first question", turns: 1 });

  // Activity, not creation time, decides the order.
  await Bun.sleep(5);
  Session.load(dir, a.id).append({ role: "user", content: "follow-up" });
  expect(Session.list(dir).map((s) => s.id)).toEqual([a.id, b.id]);
  expect(Session.list(dir)[0]).toMatchObject({ turns: 2, preview: "first question" });
});

test("loading an unknown session throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "ivy-sessions-"));
  expect(() => Session.load(dir, "nope")).toThrow("Session not found");
});

test("an unused session leaves no file behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "ivy-sessions-"));
  Session.create(dir, "m");
  expect(Session.list(dir)).toEqual([]);
});

test("a corrupt or cut-off line doesn't break loading, listing or later writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "ivy-sessions-"));
  const s = Session.create(dir, "m");
  s.append({ role: "user", content: "hello" }, { role: "assistant", content: "hi" });
  appendFileSync(s.file, '{"type":"message","ts":"x","message":{"role":"us'); // crash mid-write

  expect(Session.list(dir)[0]).toMatchObject({ id: s.id, turns: 1 });
  const loaded = Session.load(dir, s.id);
  expect(loaded.messages).toHaveLength(2);

  loaded.append({ role: "user", content: "again" });
  expect(Session.load(dir, s.id).messages.at(-1)).toEqual({ role: "user", content: "again" });
  expect(readFileSync(s.file, "utf8").endsWith("\n")).toBe(true);
});

test("a tool call without its results is dropped on load", () => {
  const dir = mkdtempSync(join(tmpdir(), "ivy-sessions-"));
  const s = Session.create(dir, "m");
  s.append({ role: "user", content: "what time is it" });
  // Simulate a crash after the assistant's tool call was written but before its results.
  s.append({
    role: "assistant",
    content: [{ type: "tool_use", id: "tu_1", name: "core__now", input: {} }],
  });
  expect(Session.load(dir, s.id).messages).toEqual([{ role: "user", content: "what time is it" }]);
});

test("listing ignores the <context> block when counting turns and building the preview", () => {
  const dir = mkdtempSync(join(tmpdir(), "ivy-sessions-"));
  const s = Session.create(dir, "m");
  s.append({
    role: "user",
    content: [
      { type: "text", text: "<context>\n## core\nNow: ...\n</context>" },
      { type: "text", text: "real question" },
    ],
  });
  s.append({ role: "assistant", content: "answer" });
  s.append({ role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "r" }] });
  expect(Session.list(dir)[0]).toMatchObject({ preview: "real question", turns: 1 });
});
