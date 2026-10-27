import { expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { claimUploads, saveUpload } from "./images.ts";
import { Session, sessionHistory, trashSession } from "./session.ts";
import { PNG } from "./testing.ts";

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

test("results whose tool call was lost to a corrupt line are dropped on load", () => {
  const dir = mkdtempSync(join(tmpdir(), "ivy-sessions-"));
  const s = Session.create(dir, "m");
  s.append({ role: "user", content: "what time is it" });
  // The call's line was cut off; its results' line survived.
  appendFileSync(s.file, '{"type":"message","ts":"x","message":{"role":"assistant","con\n');
  const result = {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "tu_1", content: "9:00" }],
  };
  appendFileSync(s.file, `${JSON.stringify({ type: "message", ts: "x", message: result })}\n`);
  s.append({ role: "assistant", content: "It's nine." });
  expect(Session.load(dir, s.id).messages).toEqual([
    { role: "user", content: "what time is it" },
    { role: "assistant", content: "It's nine." },
  ]);
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

test("history for plugins: only what was said, newest session first", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ivy-history-"));
  const old = Session.create(dir, "m");
  old.append(
    { role: "user", content: "old question" },
    { role: "assistant", content: "old answer" },
  );
  await Bun.sleep(5);
  const s = Session.create(dir, "m");
  s.appendPrompt("how do I cut a video?", "<context>\nNow: Friday\n</context>");
  s.append(
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm", signature: "x" },
        { type: "text", text: "Let me check." },
        { type: "tool_use", id: "t1", name: "shell__run", input: { cmd: "ffmpeg -h" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "long help text" }],
    },
    { role: "assistant", content: [{ type: "text", text: "Use ffmpeg -ss 0 -t 10." }] },
  );
  const history = sessionHistory(dir);
  expect(history.sessions().map((x) => x.id)).toEqual([s.id, old.id]);
  expect(history.messages(s.id).map((m) => [m.role, m.text])).toEqual([
    ["user", "how do I cut a video?"],
    ["assistant", "Let me check."],
    ["assistant", "Use ffmpeg -ss 0 -t 10."],
  ]);
  expect(history.messages("../etc/passwd")).toEqual([]);
  expect(history.messages("missing")).toEqual([]);
  expect(sessionHistory(join(dir, "none")).sessions()).toEqual([]);
});

test("a session id can't reach outside the sessions folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "ivy-sid-"));
  expect(() => Session.load(dir, "../config")).toThrow("Session not found: ../config");
});

test("a trashed session leaves the list but its file is kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "ivy-session-"));
  const s = Session.create(dir, "m");
  s.appendPrompt("forget me", "");
  expect(trashSession(dir, s.id)).toBe(true);
  expect(Session.list(dir)).toEqual([]);
  expect(existsSync(join(dir, "trash", `${s.id}.jsonl`))).toBe(true);
  expect(trashSession(dir, s.id)).toBe(false);
  expect(trashSession(dir, "../config")).toBe(false);
});

test("images are kept as files: the session file names them, and they read back on load", () => {
  const dir = mkdtempSync(join(tmpdir(), "ivy-sessions-"));
  const session = Session.create(dir, "m");
  const name = saveUpload(join(dir, "uploads"), PNG, "image/png");
  claimUploads(join(dir, "uploads"), session.imagesDir, [name]);
  session.appendPrompt("what is this?", "", [name]);

  const line = readFileSync(session.file, "utf8").trim().split("\n").at(-1) ?? "";
  expect(line).not.toContain(Buffer.from(PNG).toString("base64"));
  expect(JSON.parse(line).message.content[0]).toEqual({ type: "image", file: name });

  const loaded = Session.load(dir, session.id);
  expect(loaded.messages).toEqual(session.messages);
  const [image, text] = (loaded.messages[0]?.content ??
    []) as Anthropic.Beta.BetaContentBlockParam[];
  if (!image) throw new Error("no image");
  expect(image).toMatchObject({
    type: "image",
    source: { type: "base64", media_type: "image/png" },
  });
  expect(text).toEqual({ type: "text", text: "what is this?" });
  expect(loaded.imageOf(image)).toBe(name);
  expect(Session.list(dir)[0]).toMatchObject({ turns: 1, preview: "what is this?" });

  // Trashed, its images go with it; gone from disk, one reads as a line saying so.
  expect(trashSession(dir, session.id)).toBe(true);
  expect(existsSync(join(dir, "trash", session.id, name))).toBe(true);
  appendFileSync(
    join(dir, `${session.id}.jsonl`),
    readFileSync(join(dir, "trash", `${session.id}.jsonl`)),
  );
  expect(Session.load(dir, session.id).messages[0]?.content).toContainEqual({
    type: "text",
    text: "[An image that is no longer on disk]",
  });
});

test("which calls brought in outside content is kept with the session", () => {
  const dir = mkdtempSync(join(tmpdir(), "ivy-sessions-"));
  const s = Session.create(dir, "m");
  s.appendPrompt("read this page", "");
  s.markOutside("web__fetch", ["tu_1"]);
  // A later call in the same turn records its own, though the turn is tainted already.
  s.markOutside("web__fetch", ["tu_2"]);
  const loaded = Session.load(dir, s.id);
  expect([loaded.readOutside("tu_1"), loaded.readOutside("tu_2"), loaded.readOutside("x")]).toEqual(
    [true, true, false],
  );
});

test("past conversations are read again once their file changes, and not once it is gone", () => {
  const dir = mkdtempSync(join(tmpdir(), "ivy-history-"));
  const s = Session.create(dir, "m");
  s.append({ role: "user", content: "first" }, { role: "assistant", content: "hi" });
  const history = sessionHistory(dir);
  const before = history.messages(s.id);
  expect(history.messages(s.id)).toBe(before); // unchanged: the same read
  s.append({ role: "user", content: "second" });
  expect(history.messages(s.id).map((m) => m.text)).toEqual(["first", "hi", "second"]);
  trashSession(dir, s.id);
  expect(history.messages(s.id)).toEqual([]);
});

test("an off-the-record conversation reads as nothing to plugins, but lists for the user", () => {
  const dir = mkdtempSync(join(tmpdir(), "ivy-offrecord-"));
  const kept = Session.create(dir, "m");
  kept.append({ role: "user", content: "kept" }, { role: "assistant", content: "ok" });
  const off = Session.create(dir, "m", { offRecord: true });
  off.append({ role: "user", content: "secret" }, { role: "assistant", content: "ok" });
  const history = sessionHistory(dir);
  expect(history.sessions().map((s) => s.id)).toEqual([kept.id]);
  expect(history.messages(off.id)).toEqual([]);
  writeFileSync(
    join(dir, `${off.id}.points.json`),
    '{"title":"x","points":[],"open":[],"through":"z"}',
  );
  expect(history.points(off.id)).toBeUndefined();
  // The user still sees it, marked, until it is let go.
  expect(Session.list(dir).find((s) => s.id === off.id)?.offRecord).toBe(true);
  expect(Session.load(dir, off.id).offRecord).toBe(true);
});
