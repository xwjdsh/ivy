import { expect, test } from "bun:test";
import * as E from "./editor.ts";

const at = (value: string, cursor = value.length): E.EditorState => ({ value, cursor });

test("insert and backspace at the cursor", () => {
  expect(E.insert(at("ac", 1), "b")).toEqual(at("abc", 2));
  expect(E.backspace(at("abc", 2))).toEqual(at("ac", 1));
  expect(E.backspace(at("abc", 0))).toEqual(at("abc", 0));
  expect(E.deleteForward(at("abc", 0))).toEqual(at("bc", 0));
});

test("emoji are edited as one character", () => {
  expect(E.backspace(at("a😀"))).toEqual(at("a"));
  expect(E.left(at("a😀"))).toEqual(at("a😀", 1));
});

test("line navigation and deletion", () => {
  const s = at("one\ntwo three", 8);
  expect(E.lineStart(s).cursor).toBe(4);
  expect(E.lineEnd(s).cursor).toBe(13);
  expect(E.deleteToLineStart(s)).toEqual(at("one\nthree", 4));
  expect(E.deleteWordBefore(at("two three"))).toEqual(at("two "));
});

test("vertical move keeps the column and stops at the edges", () => {
  expect(E.verticalMove(at("abcd\nxy", 7), -1)).toEqual(at("abcd\nxy", 2));
  expect(E.verticalMove(at("abcd\nxy", 3), 1)).toEqual(at("abcd\nxy", 7));
  expect(E.verticalMove(at("abc", 1), -1)).toBeNull();
});

test("wrap counts CJK as two columns", () => {
  expect(E.wrap("你好世界", 4).map((r) => r.text)).toEqual(["你好", "世界"]);
  expect(E.wrap("ab\ncd", 10).map((r) => r.start)).toEqual([0, 3]);
});

test("cursor cell accounts for wide characters and wrapping", () => {
  const rows = E.wrap("你好世界", 4);
  expect(E.cursorCell(rows, 1)).toEqual({ row: 0, col: 2 });
  expect(E.cursorCell(rows, 3)).toEqual({ row: 1, col: 2 });
  // After a full row the cursor stays on it, in the spare column.
  expect(E.cursorCell(E.wrap("abcd", 4), 4)).toEqual({ row: 0, col: 4 });
});
