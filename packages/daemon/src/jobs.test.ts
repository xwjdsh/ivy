import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobRun } from "@ivy/plugin-api";
import { CATCH_UP_MS, startJobs } from "./jobs.ts";

function harness(fail: () => boolean = () => false) {
  const stateFile = join(mkdtempSync(join(tmpdir(), "ivy-jobs-")), "jobs.json");
  const runs: JobRun[] = [];
  const clock = { now: new Date(2026, 9, 23, 3, 0) };
  const start = () =>
    startJobs({
      stateFile,
      now: () => clock.now,
      intervalMs: 3_600_000, // checks are called by hand
      jobs: [
        {
          plugin: "p",
          name: "j",
          at: () => "04:00",
          async run(r) {
            runs.push(r);
            if (fail()) throw new Error("model down");
          },
        },
      ],
    });
  return { runs, clock, start };
}

test("a job runs once a date from its time on, told what it last finished", async () => {
  const { runs, clock, start } = harness();
  const jobs = start();
  await jobs.check(); // 03:00: not yet
  expect(runs).toHaveLength(0);
  clock.now = new Date(2026, 9, 23, 4, 0);
  await jobs.check();
  await jobs.check(); // once a date
  expect(runs).toHaveLength(1);
  // A first run catches up a week, at most.
  expect(clock.now.getTime() - (runs[0]?.since.getTime() ?? 0)).toBe(CATCH_UP_MS);
  jobs.stop();
  // The Mac asleep two days: on waking, once, from where it last finished.
  clock.now = new Date(2026, 9, 25, 9, 30);
  const again = start();
  await again.check();
  expect(runs).toHaveLength(2);
  expect(runs[1]?.since).toEqual(new Date(2026, 9, 23, 4, 0));
  again.stop();
});

test("a run that fails is tried the next day, from where it last finished", async () => {
  let failing = false;
  const { runs, clock, start } = harness(() => failing);
  clock.now = new Date(2026, 9, 23, 4, 0);
  const jobs = start();
  await jobs.check();
  failing = true;
  clock.now = new Date(2026, 9, 24, 4, 0);
  await jobs.check();
  await jobs.check(); // not again the same day
  expect(runs).toHaveLength(2);
  failing = false;
  clock.now = new Date(2026, 9, 25, 4, 0);
  await jobs.check();
  expect(runs.map((r) => r.since)).toEqual([
    new Date(clock.now.getTime() - 2 * 24 * 3_600_000 - CATCH_UP_MS),
    new Date(2026, 9, 23, 4, 0),
    new Date(2026, 9, 23, 4, 0),
  ]);
  jobs.stop();
});

test("a run cut short by Ivy stopping isn't done: the next start does it, the same day", async () => {
  const stateFile = join(mkdtempSync(join(tmpdir(), "ivy-jobs-")), "jobs.json");
  const runs: JobRun[] = [];
  const now = () => new Date(2026, 9, 23, 9, 0);
  const job = {
    plugin: "p",
    name: "j",
    at: () => "04:00",
    async run(r: JobRun) {
      runs.push(r);
      // Gives up once stopped: quietly the first time, with an error (as a model call does)
      // the second.
      const quiet = runs.length === 1;
      await new Promise<void>((resolve, reject) =>
        r.signal.addEventListener("abort", () =>
          quiet ? resolve() : reject(new Error("aborted")),
        ),
      );
    },
  };
  const first = startJobs({ stateFile, now, intervalMs: 3_600_000, jobs: [job] });
  const running = first.check();
  first.stop();
  await running;
  const second = startJobs({ stateFile, now, intervalMs: 3_600_000, jobs: [job] });
  const again = second.check();
  second.stop();
  await again;
  const quick = { ...job, run: async (r: JobRun) => void runs.push(r) };
  const third = startJobs({ stateFile, now, intervalMs: 3_600_000, jobs: [quick] });
  await third.check();
  expect(runs).toHaveLength(3);
  expect(runs[2]?.since).toEqual(runs[0]?.since);
  third.stop();
});
