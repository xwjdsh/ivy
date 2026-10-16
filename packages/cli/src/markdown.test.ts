import { expect, test } from "bun:test";
import { splitFinished } from "./markdown.ts";

test("finished paragraphs split off at blank lines", () => {
  expect(splitFinished("one\n\ntwo")).toEqual(["one", "two"]);
  expect(splitFinished("one\n\ntwo\n\nthr")).toEqual(["one\n\ntwo", "thr"]);
});

test("no split without a completed blank line", () => {
  expect(splitFinished("one\ntwo")).toEqual(["", "one\ntwo"]);
  expect(splitFinished("one\n")).toEqual(["", "one\n"]);
});

test("never splits inside a code fence", () => {
  const open = "intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n";
  expect(splitFinished(open)).toEqual(["intro", "```ts\nconst a = 1;\n\nconst b = 2;\n"]);
  const closed = "```ts\na\n\nb\n```\n\nafter";
  expect(splitFinished(closed)).toEqual(["```ts\na\n\nb\n```", "after"]);
});
