import { expect, test } from "bun:test";
import { renderMarkdown, splitFinished } from "./markdown.ts";

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

// Strip ANSI styling: what's left must have no Markdown markers.
const plain = (md: string) => Bun.stripANSI(renderMarkdown(md, 80));

test("inline formatting renders inside list items too, not just paragraphs", () => {
  for (const md of [
    "只剩 **Sun** 了",
    "- item **bold** and `code`",
    "1. **粗体**：说明",
    "- a\n  - nested **b**",
    "- a\n\n- loose **b**",
  ]) {
    const out = plain(md);
    expect(out).not.toContain("**");
    expect(out).not.toContain("`");
  }
});

test("a task item shows one checkbox, tight or loose", () => {
  expect(plain("- [ ] task\n- [x] done").match(/\[[ X]\]/g)).toEqual(["[ ]", "[X]"]);
  expect(plain("- a\n\n- [ ] loose").match(/\[[ X]\]/g)).toEqual(["[ ]"]);
});
