import type { Logger } from "@ivy/plugin-api";

const LEVELS = ["debug", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

let minLevel: Level = "warn";

export function setLogLevel(level: Level): void {
  minLevel = level;
}

/** Logs go to stderr so they never mix with streamed assistant output. */
export function createLogger(scope: string): Logger {
  const at = (level: Level) => (msg: string, data?: unknown) => {
    if (LEVELS.indexOf(level) < LEVELS.indexOf(minLevel)) return;
    const suffix = data === undefined ? "" : ` ${JSON.stringify(data)}`;
    process.stderr.write(`[${level}] ${scope}: ${msg}${suffix}\n`);
  };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}
