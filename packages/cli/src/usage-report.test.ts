import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "@ivy/kernel";
import { compact, usageReport } from "./usage-report.ts";

test("compact token counts", () => {
  expect(compact(999)).toBe("999");
  expect(compact(12_345)).toBe("12.3k");
  expect(compact(2_500_000)).toBe("2.5M");
});

test("report lists this session, today, last 7 days and all time", () => {
  const dir = mkdtempSync(join(tmpdir(), "ivy-report-"));
  const s = Session.create(dir, "m");
  s.recordUsage(
    {
      input_tokens: 1200,
      output_tokens: 80,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 0,
    } as never,
    0.0123,
  );
  const report = usageReport(dir, s.id);
  expect(report).toContain("  This session   1 calls");
  expect(report).toContain("in 1.2k  out 80  cache read 5.0k / write 0");
  expect(report).toMatch(/Today\s+1 calls\s+1 sessions/);
  expect(report).toMatch(/All time\s+1 calls/);
  expect(report).not.toContain("$");
});
