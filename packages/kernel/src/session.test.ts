import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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
