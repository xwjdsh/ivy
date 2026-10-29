import { expect, test } from "bun:test";
import type { SessionSummary } from "@ivy/protocol";
import { carriesOn } from "./thread.ts";

const at = (id: string, updated: Date): SessionSummary => ({
  id,
  createdAt: updated.toISOString(),
  updatedAt: updated.toISOString(),
  turns: 1,
  preview: id,
  busy: false,
});

const now = new Date(2026, 9, 20, 15);

test("the talk carries on until a pause, a new day, or too large a prompt", () => {
  const ms = now.getTime();
  expect(carriesOn(at("a", new Date(2026, 9, 20, 13)), 0, ms)).toBe(true);
  expect(carriesOn(at("b", new Date(2026, 9, 20, 11)), 0, ms)).toBe(false);
  expect(carriesOn(at("c", new Date(2026, 9, 20, 13)), 79_999, ms)).toBe(true);
  expect(carriesOn(at("c", new Date(2026, 9, 20, 13)), 80_000, ms)).toBe(false);
  // Past midnight is the same day until 04:00; then a new one starts.
  const at330 = new Date(2026, 9, 21, 3, 30).getTime();
  expect(carriesOn(at("d", new Date(2026, 9, 21, 1)), 0, at330)).toBe(true);
  expect(carriesOn(at("e", new Date(2026, 9, 21, 3)), 0, at330 + 3600_000)).toBe(false);
  // Her message, unanswered, is answered where she wrote it, while she waits for it.
  const hers = (d: Date) => ({ ...at("f", d), turns: 0, fromIvy: true as const });
  expect(carriesOn(hers(new Date(2026, 9, 19, 9)), 0, ms)).toBe(true);
  expect(carriesOn(hers(new Date(2026, 9, 16, 9)), 0, ms)).toBe(false);
});
