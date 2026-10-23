// Plugins' jobs (DESIGN.md §5.6): each runs once a local date, from its time on, every
// minute's check finding out whether it is due. Missed ones are caught up, not skipped: a
// job is told when it last ran to the end (at most a week ago) and does what came due since,
// so a Mac asleep at the time, a daemon that wasn't running, or a run that failed is made up
// for at the next chance. Not gated on the app: what a job writes needs no one to show it.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger, errorMessage } from "@ivy/kernel";
import { type JobDef, localDate, localTime } from "@ivy/plugin-api";

/** The furthest back a job is asked to catch up. */
export const CATCH_UP_MS = 7 * 24 * 60 * 60 * 1000;

interface JobState {
  /** The local date it was last tried on: once a date, so a failing one doesn't burn tokens. */
  attemptedOn?: string;
  /** When it last ran to the end. */
  completedAt?: string;
}

export interface JobsOptions {
  /** Where each job's last attempt and completion are kept, by "<plugin>:<job>". */
  stateFile: string;
  jobs: Array<JobDef & { plugin: string }>;
  now?: () => Date;
  /** A fixed interval instead of minute starts (tests). */
  intervalMs?: number;
}

export interface Jobs {
  /** Run what is due now (also on start and every minute). */
  check(): Promise<void>;
  /** Whether a job is running: an idle daemon waits for it. */
  readonly busy: boolean;
  stop(): void;
}

const log = createLogger("jobs");

export function startJobs(opts: JobsOptions): Jobs {
  const now = opts.now ?? (() => new Date());
  const stopping = new AbortController();
  let running: Promise<void> | undefined;

  const runDue = async () => {
    const at = now();
    const today = localDate(at);
    const clock = localTime(at);
    for (const job of opts.jobs) {
      const key = `${job.plugin}:${job.name}`;
      const state = readState(opts.stateFile);
      const mine = state[key] ?? {};
      if (mine.attemptedOn === today || clock < job.at() || stopping.signal.aborted) continue;
      writeState(opts.stateFile, { ...state, [key]: { ...mine, attemptedOn: today } });
      const floor = at.getTime() - CATCH_UP_MS;
      const last = mine.completedAt ? Date.parse(mine.completedAt) : Number.NaN;
      const since = new Date(Number.isNaN(last) ? floor : Math.max(last, floor));
      try {
        await job.run({ now: at, since, signal: stopping.signal });
        const after = readState(opts.stateFile);
        // Cut short by Ivy stopping, it did only part of its work: the next start does it,
        // the same day too.
        const done = stopping.signal.aborted
          ? { completedAt: after[key]?.completedAt }
          : { ...after[key], completedAt: at.toISOString() };
        writeState(opts.stateFile, { ...after, [key]: done });
        if (!stopping.signal.aborted) log.info(`${key} ran`);
      } catch (err) {
        if (stopping.signal.aborted) {
          // Stopped, not failed: the next start does it, the same day too.
          const after = readState(opts.stateFile);
          writeState(opts.stateFile, { ...after, [key]: { completedAt: after[key]?.completedAt } });
        } else {
          // Tried again tomorrow, from the same `since`.
          log.warn(`${key} failed`, errorMessage(err));
        }
      }
    }
  };
  // One check at a time: a job can take minutes.
  const check = () => {
    running ??= runDue().finally(() => {
      running = undefined;
    });
    return running;
  };

  void check();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const next = () => {
    if (stopping.signal.aborted) return;
    const wait = opts.intervalMs ?? 60_000 - (Date.now() % 60_000);
    timer = setTimeout(() => {
      void check();
      next();
    }, wait);
  };
  next();
  return {
    check,
    get busy() {
      return running !== undefined;
    },
    stop: () => {
      stopping.abort();
      clearTimeout(timer);
    },
  };
}

function readState(file: string): Record<string, JobState> {
  if (!existsSync(file)) return {};
  try {
    const data: unknown = JSON.parse(readFileSync(file, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, JobState>)
      : {};
  } catch {
    return {}; // a broken state file: as on a first run
  }
}

function writeState(file: string, state: Record<string, JobState>): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}
