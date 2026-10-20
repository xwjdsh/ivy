import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReminderWindow } from "@ivy/plugin-api";
import { startScheduler } from "./scheduler.ts";
import type { DaemonEvent } from "./server.ts";

const T0 = new Date("2026-10-20T08:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

/** A scheduler on a fake clock, with one reminder due at `dueMinutes` after T0. */
function setup(
  dueMinutes = 10,
  stateFile = join(mkdtempSync(join(tmpdir(), "ivy-s-")), "s.json"),
  startAt = T0,
) {
  let clock = startAt;
  const windows: ReminderWindow[] = [];
  const events: DaemonEvent[] = [];
  const scheduler = startScheduler({
    stateFile,
    now: () => clock,
    intervalMs: 1e9, // checks are driven by the test
    publish: (e) => events.push(e),
    reminders: async (w) => {
      windows.push(w);
      const due = at(dueMinutes);
      return due > w.since && due <= w.now
        ? [{ id: "memory:x", plugin: "memory", title: "Pick up the parcel" }]
        : [];
    },
  });
  return {
    scheduler,
    windows,
    events,
    stateFile,
    setClock: (d: Date) => {
      clock = d;
    },
  };
}

test("the first run starts from now: nothing old pops up", async () => {
  const s = setup(-5); // overdue before the daemon ever ran
  await s.scheduler.check();
  expect(s.events).toEqual([]);
  s.scheduler.stop();
});

test("each reminder is announced once, in the check after its time", async () => {
  const s = setup(10);
  await s.scheduler.check();
  s.setClock(at(9.5));
  await s.scheduler.check();
  expect(s.events).toEqual([]);
  s.setClock(at(10));
  await s.scheduler.check();
  s.setClock(at(10.5));
  await s.scheduler.check();
  expect(s.events).toEqual([
    { type: "reminder", data: { id: "memory:x", plugin: "memory", title: "Pick up the parcel" } },
  ]);
  s.scheduler.stop();
});

test("asleep or stopped across the time: announced on the first check after", async () => {
  const s = setup(10);
  await s.scheduler.check();
  s.scheduler.stop();
  // A new daemon, hours later, reading the same state file.
  const later = setup(10, s.stateFile, at(300));
  await later.scheduler.check();
  expect(later.events).toHaveLength(1);
  expect(JSON.parse(readFileSync(s.stateFile, "utf8")).lastCheck).toBe(at(300).toISOString());
  later.scheduler.stop();
});

test("a clock set back asks about nothing; a broken state file starts from now", async () => {
  const s = setup(10);
  await s.scheduler.check();
  const asked = s.windows.length;
  s.setClock(at(-60));
  await s.scheduler.check();
  expect(s.windows.length).toBe(asked);
  s.scheduler.stop();

  writeFileSync(s.stateFile, "not json");
  const fresh = setup(-1, s.stateFile);
  await fresh.scheduler.check();
  expect(fresh.events).toEqual([]);
  fresh.scheduler.stop();
});
