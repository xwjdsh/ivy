// The daemon's scheduler: at the start of every minute it asks the plugins which
// reminders came due since it last asked, and announces each as a `reminder` event (the
// menu-bar app shows it as a notification). Asking about "since the last check" announces
// each reminder once, catches up after the Mac slept or the daemon was off, and on the very
// first run starts from now, so old overdue todos don't all pop up at once. No model is
// involved.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger, errorMessage } from "@ivy/kernel";
import type { Reminder, ReminderWindow } from "@ivy/plugin-api";
import type { DaemonEvent } from "./server.ts";

/**
 * Reminder times are to the minute, so checks run just after each minute starts: a todo
 * due at 17:00 is announced at 17:00, not up to an interval later.
 */
const AFTER_MINUTE_MS = 200;
/**
 * A reminder this late (the Mac asleep overnight and more) is dropped rather than shown:
 * a weekend's worth shouldn't pop up on Monday, and overdue todos still come up in chat.
 */
export const STALE_AFTER_MS = 12 * 60 * 60 * 1000;

export interface SchedulerOptions {
  /** Where the time of the last check is kept, so a restart or a sleep loses nothing. */
  stateFile: string;
  reminders(window: ReminderWindow): Promise<Array<Reminder & { plugin: string }>>;
  publish(event: DaemonEvent): void;
  now?: () => Date;
  /** A fixed interval instead of minute starts (tests). */
  intervalMs?: number;
}

export interface Scheduler {
  /** Check now (also run on start and every interval). */
  check(): Promise<void>;
  stop(): void;
}

const log = createLogger("scheduler");

export function startScheduler(opts: SchedulerOptions): Scheduler {
  const now = opts.now ?? (() => new Date());
  let running: Promise<void> | undefined;

  const checkOnce = async () => {
    const until = now();
    const since = lastCheck(opts.stateFile) ?? until;
    // A clock set back gives an empty window; the next check starts from the new time.
    if (until > since) {
      for (const r of await opts.reminders({ since, now: until })) {
        if (r.at && until.getTime() - r.at.getTime() > STALE_AFTER_MS) {
          log.info(`reminder too late to show: ${r.title}`);
          continue;
        }
        opts.publish({ type: "reminder", data: r });
        log.info(`reminder: ${r.title}`);
      }
    }
    saveLastCheck(opts.stateFile, until);
  };
  // One check at a time: a slow plugin must not let two windows overlap.
  const check = () => {
    running ??= checkOnce()
      .catch((err) => log.warn("check failed", errorMessage(err)))
      .finally(() => {
        running = undefined;
      });
    return running;
  };

  void check();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const next = () => {
    if (stopped) return;
    // The real clock, not `now`: this is about when to wake up, after a sleep too.
    const wait = opts.intervalMs ?? 60_000 - (Date.now() % 60_000) + AFTER_MINUTE_MS;
    timer = setTimeout(() => {
      void check();
      next();
    }, wait);
  };
  next();
  return {
    check,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

function lastCheck(file: string): Date | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const at = new Date(
      (JSON.parse(readFileSync(file, "utf8")) as { lastCheck?: string }).lastCheck ?? "",
    );
    return Number.isNaN(at.getTime()) ? undefined : at;
  } catch {
    return undefined; // a broken state file: start from now, as on a first run
  }
}

function saveLastCheck(file: string, at: Date): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ lastCheck: at.toISOString() })}\n`);
  renameSync(`${file}.tmp`, file);
}
