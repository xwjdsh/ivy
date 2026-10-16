import { afterEach, expect, test } from "bun:test";
import { createLogger, setLogLevel, setLogSink } from "./log.ts";

afterEach(() => {
  setLogSink(null);
  setLogLevel("warn");
});

test("a log sink receives lines at or above the level, instead of stderr", () => {
  const lines: string[] = [];
  setLogSink((line) => lines.push(line));
  const log = createLogger("memory");
  log.info("hidden at warn level");
  log.warn("context skipped", { reason: "timeout" });
  setLogLevel("debug");
  log.debug("now visible");
  expect(lines).toEqual([
    '[warn] memory: context skipped {"reason":"timeout"}',
    "[debug] memory: now visible",
  ]);
});
