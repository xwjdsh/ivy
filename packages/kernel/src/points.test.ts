import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Helper } from "./helper.ts";
import { Points, parsePoints } from "./points.ts";
import { Session, sessionHistory, trashSession } from "./session.ts";

/** A helper that answers each call in turn, and keeps what it was asked. */
function helper(...answers: string[]) {
  const asked: string[] = [];
  const fake = {
    async complete(call: { prompt: string }) {
      asked.push(call.prompt);
      return answers.shift() ?? "";
    },
  };
  return { asked, helper: fake as unknown as Helper };
}

const ANSWER =
  'Here you go:\n{"title": "面试准备", "points": ["周四有面试", "有点紧张"], "open": ["周四面试结果"]}';

function talk(dir: string) {
  const s = Session.create(dir, "m");
  s.appendPrompt("周四有个面试，有点紧张", "");
  s.append({ role: "assistant", content: "加油，准备得怎么样了？" });
  s.appendPrompt("你帮我查查这家公司", "");
  s.markOutside("web_search");
  s.append({ role: "assistant", content: "页面说他们在裁员" });
  return s;
}

test("a conversation is summed up once, from what was said, beside it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ivy-points-"));
  const s = talk(dir);
  const history = sessionHistory(dir);
  const before = { listed: Session.list(dir), order: history.sessions() };

  const h = helper(ANSWER);
  const points = new Points(dir, history, h.helper);
  await points.sumUp(s.id);
  expect(h.asked[0]).toContain("周四有个面试");
  // Ivy's reply in the turn that read a page is left out, marked as there.
  expect(h.asked[0]).not.toContain("裁员");
  expect(h.asked[0]).toContain("[a reply from what a web page or search said, left out]");
  expect(history.points(s.id)).toEqual({
    title: "面试准备",
    points: ["周四有面试", "有点紧张"],
    open: ["周四面试结果"],
    through: expect.any(String),
  });
  // The transcript isn't touched: its time and order stay those of the last activity.
  expect(Session.list(dir)).toEqual(before.listed);
  expect(history.sessions()).toEqual(before.order);

  // Nothing new said: not asked again. Trashed, its points go with it.
  await points.sumUp(s.id);
  expect(h.asked).toHaveLength(1);
  trashSession(dir, s.id);
  expect(existsSync(join(dir, `${s.id}.points.json`))).toBe(false);
  expect(existsSync(join(dir, "trash", `${s.id}.points.json`))).toBe(true);
});

test("on start, the recent conversations not summed up are; a first turn can wait for them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ivy-points-"));
  const a = talk(dir);
  const slight = Session.create(dir, "m");
  slight.appendPrompt("hi", "");
  const h = helper(ANSWER);
  const points = new Points(dir, sessionHistory(dir), h.helper);
  points.catchUp();
  await points.settled();
  // The one-line conversation is too slight to sum up.
  expect(h.asked).toHaveLength(1);
  expect(sessionHistory(dir).points(a.id)?.title).toBe("面试准备");
  expect(sessionHistory(dir).points(slight.id)).toBeUndefined();
});

test("an answer that isn't the JSON asked for keeps nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ivy-points-"));
  const s = talk(dir);
  await new Points(dir, sessionHistory(dir), helper("Sorry, I can't.").helper).sumUp(s.id);
  expect(sessionHistory(dir).points(s.id)).toBeUndefined();
  expect(parsePoints("no braces at all")).toBeUndefined();
  // A points file damaged by hand is none, not a failing reader.
  writeFileSync(join(dir, `${s.id}.points.json`), '{"title": "t", "points": "not a list"}');
  expect(sessionHistory(dir).points(s.id)).toBeUndefined();
  expect(parsePoints('{"title": "", "points": []}')).toBeUndefined();
  expect(parsePoints('{"title": "t", "points": ["a", 3, "b"], "open": "x"}')).toEqual({
    title: "t",
    points: ["a", "b"],
    open: [],
  });
});
