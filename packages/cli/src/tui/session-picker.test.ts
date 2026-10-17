import { expect, test } from "bun:test";
import stringWidth from "string-width";
import { fit } from "./session-picker.tsx";

test("fit pads or cuts to exact terminal columns, CJK included", () => {
  for (const text of [
    "short",
    "a much longer preview than fits",
    "这是一段很长的中文会话预览内容",
    "mixed 中文 text",
  ]) {
    expect(stringWidth(fit(text, 12))).toBe(12);
  }
  expect(fit("这是一段很长的中文", 8)).toBe("这是一… ");
});
