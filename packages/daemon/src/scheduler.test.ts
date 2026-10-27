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
  deliverable = { now: true },
) {
  let clock = startAt;
  const windows: ReminderWindow[] = [];
  const events: DaemonEvent[] = [];
  const scheduler = startScheduler({
    stateFile,
    now: () => clock,
    intervalMs: 1e9, // checks are driven by the test
    publish: (e) => events.push(e),
    canDeliver: () => deliverable.now,
    reminders: async (w) => {
      windows.push(w);
      const due = at(dueMinutes);
      return due > w.since && due <= w.now
        ? [{ id: "memory:x", plugin: "memory", title: "Pick up the parcel", at: due }]
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
    {
      type: "reminder",
      data: { id: "memory:x", plugin: "memory", title: "Pick up the parcel", at: at(10) },
      notify: true,
    },
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

test("a reminder more than 12 hours late is dropped, not shown", async () => {
  const s = setup(10);
  await s.scheduler.check();
  s.scheduler.stop();
  const weekend = setup(10, s.stateFile, at(10 + 12 * 60 + 1));
  await weekend.scheduler.check();
  expect(weekend.events).toEqual([]);
  weekend.scheduler.stop();
});

test("with no one to show reminders, the window stays open until someone is", async () => {
  const app = { now: true };
  const s = setup(10, undefined, T0, app);
  await s.scheduler.check(); // the first run, with the app there
  app.now = false; // the app quit; only a terminal is connected
  s.setClock(at(15));
  await s.scheduler.check();
  expect(s.events).toEqual([]);
  app.now = true; // the app is back
  s.setClock(at(20));
  await s.scheduler.check();
  expect(s.events.map((e) => (e.data as { title: string }).title)).toEqual(["Pick up the parcel"]);
  expect(s.windows.at(-1)).toEqual({ since: T0, now: at(20) }); // one window from the last check
  s.scheduler.stop();
});

test("hers go to writing first after the notifications; one that fails stops nothing", async () => {
  const events: DaemonEvent[] = [];
  const written: string[] = [];
  let clock = T0;
  const scheduler = startScheduler({
    stateFile: join(mkdtempSync(join(tmpdir(), "ivy-s-")), "s.json"),
    now: () => clock,
    intervalMs: 1e9,
    publish: (e) => events.push(e),
    reminders: async () => [
      { id: "f1", plugin: "memory", title: "ask about the interview", from: "ivy" },
      { id: "f2", plugin: "memory", title: "ask about the trip", from: "ivy" },
      { id: "t", plugin: "memory", title: "Pick up the parcel", at: T0 },
    ],
    writeFirst: async (r) => {
      if (r.id === "f1") throw new Error("model down");
      written.push(r.id);
    },
  });
  await scheduler.check(); // the first check starts from now: an empty window
  clock = at(1);
  await scheduler.check();
  await Bun.sleep(10); // hers are written apart from the check
  scheduler.stop();
  expect(events.map((e) => (e.data as { title: string }).title)).toEqual(["Pick up the parcel"]);
  expect(written).toEqual(["f2"]);
});
