import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "./session.ts";
import { summarizeUsage } from "./usage.ts";

const usage = (input: number, output: number, cacheRead = 0) =>
  ({
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: 0,
  }) as never;

test("sums usage per session, across sessions, and since a time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ivy-usage-"));
  const a = Session.create(dir, "m");
  a.recordUsage(usage(100, 10, 50), 0.01);
  a.recordUsage(usage(200, 20), 0.02);
  await Bun.sleep(5);
  const cutoff = new Date();
  await Bun.sleep(5);
  const b = Session.create(dir, "m");
  b.recordUsage(usage(300, 30), 0.03);

  expect(summarizeUsage(dir, { sessionId: a.id })).toMatchObject({
    calls: 2,
    inputTokens: 300,
    outputTokens: 30,
    cacheReadTokens: 50,
    sessions: 1,
  });
  expect(summarizeUsage(dir, { sessionId: a.id }).costUsd).toBeCloseTo(0.03);

  const all = summarizeUsage(dir);
  expect(all).toMatchObject({ calls: 3, sessions: 2 });
  expect(all.costUsd).toBeCloseTo(0.06);

  expect(summarizeUsage(dir, { since: cutoff })).toMatchObject({ calls: 1, sessions: 1 });
  expect(summarizeUsage(dir, { sessionId: "missing" }).calls).toBe(0);
});
