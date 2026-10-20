import { expect, test } from "bun:test";
import { compact, formatTokens, tokensFromUsage } from "./index.ts";

test("compact token counts", () => {
  expect(compact(999)).toBe("999");
  expect(compact(12_345)).toBe("12.3k");
  expect(compact(2_500_000)).toBe("2.5M");
});

test("token summary shows the cached part only when there is one", () => {
  expect(formatTokens({ in: 3500, cached: 3400, out: 32 })).toBe("3.5k in (3.4k cached) / 32 out");
  expect(formatTokens({ in: 10, cached: 0, out: 5 })).toBe("10 in / 5 out");
});

test("tokens count the whole prompt sent: input plus cache reads and writes", () => {
  expect(tokensFromUsage({ input: 12, output: 20, cacheRead: 3200, cacheWrite: 120 })).toEqual({
    in: 3332,
    cached: 3200,
    out: 20,
  });
});
