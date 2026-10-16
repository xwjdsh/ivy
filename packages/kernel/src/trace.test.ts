import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneTraces } from "./trace.ts";

test("prunes trace folders older than the retention period", () => {
  const dir = mkdtempSync(join(tmpdir(), "ivy-traces-"));
  const old = join(dir, "old-session");
  const recent = join(dir, "recent-session");
  mkdirSync(old);
  mkdirSync(recent);
  const tenDaysAgo = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000;
  utimesSync(old, tenDaysAgo, tenDaysAgo);

  expect(pruneTraces(dir, 7)).toBe(1);
  expect(existsSync(old)).toBe(false);
  expect(existsSync(recent)).toBe(true);
});

test("retention 0 keeps everything; a missing dir is fine", () => {
  const dir = mkdtempSync(join(tmpdir(), "ivy-traces-"));
  mkdirSync(join(dir, "s"));
  expect(pruneTraces(dir, 0, Date.now() + 1e12)).toBe(0);
  expect(pruneTraces(join(dir, "nope"), 7)).toBe(0);
});
