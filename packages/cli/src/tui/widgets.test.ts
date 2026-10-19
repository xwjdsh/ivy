import { expect, test } from "bun:test";
import { inputLines } from "./widgets.tsx";

test("a permission prompt shows input as JSON", () => {
  expect(inputLines({ path: "/tmp/x" })).toEqual(["{", '  "path": "/tmp/x"', "}"]);
});

test("multi-line text in a prompt reads as written, not as one escaped line", () => {
  expect(
    inputLines({
      why: "settled",
      old_text: "- Be direct.",
      new_text: "- Be direct.\n- Say no openly.",
    }),
  ).toEqual([
    'why: "settled"',
    'old_text: "- Be direct."',
    "new_text:",
    "  │ - Be direct.",
    "  │ - Say no openly.",
  ]);
});
