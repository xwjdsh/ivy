import { expect, test } from "bun:test";
import { changeNotice } from "./changes.ts";

const set = (...lines: string[]) => new Set(lines);

test("no change, no notice; changes are listed as + and -", () => {
  expect(changeNotice("F.md", set("a"), set("a"), "look in F.md", 2000)).toBeNull();
  expect(changeNotice("F.md", set("a", "b"), set("b", "c"), "look in F.md", 2000)).toBe(
    "F.md changed since this session started:\n+ c\n- a",
  );
});

test("past the budget: whole lines only, and the pointer always fits", () => {
  const now = set(...Array.from({ length: 10 }, (_, i) => `line ${i} ${"x".repeat(40)}`));
  // Real budgets are a plugin's share of the turn's context: hundreds of characters at least.
  for (const budget of [100, 200, 400]) {
    const notice = changeNotice("F.md", set(), now, "look in F.md", budget) ?? "";
    expect(notice.length).toBeLessThanOrEqual(budget);
    const shown = notice.split("\n").filter((l) => l.startsWith("+ "));
    for (const l of shown) expect(now.has(l.slice(2))).toBe(true);
    expect(notice).toEndWith(`(${10 - shown.length} more changes; look in F.md)`);
  }
});

test("everything shown when it fits, with no pointer", () => {
  const notice = changeNotice("F.md", set(), set("a", "b"), "look", 2000) ?? "";
  expect(notice).not.toContain("more changes");
});
