import type { Logger } from "@ivy/plugin-api";

const LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LEVELS)[number];

let minLevel: LogLevel = "warn";
let sink: ((line: string, level: LogLevel) => void) | null = null;

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

/**
 * Send log lines somewhere other than stderr, e.g. into the TUI (where stderr would
 * corrupt the screen). Pass null to go back to stderr.
 */
export function setLogSink(fn: ((line: string, level: LogLevel) => void) | null): void {
  sink = fn;
}

/** Logs go to stderr (or the sink) so they never mix with streamed assistant output. */
export function createLogger(scope: string): Logger {
  const at = (level: LogLevel) => (msg: string, data?: unknown) => {
    if (LEVELS.indexOf(level) < LEVELS.indexOf(minLevel)) return;
    const suffix = data === undefined ? "" : ` ${JSON.stringify(data)}`;
    const line = `[${level}] ${scope}: ${msg}${suffix}`;
    if (sink) sink(line, level);
    else process.stderr.write(`${line}\n`);
  };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}
