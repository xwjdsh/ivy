import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type loadConfig, Session, type Writer } from "@ivy/kernel";
import type { Reminder } from "@ivy/plugin-api";
import type { DaemonEvent } from "./server.ts";
import { inQuiet, mayWrite, writeFirst } from "./writes-first.ts";

const at = (s: string) => new Date(s); // local

function setup(answer = "面试怎么样了？") {
  const dir = mkdtempSync(join(tmpdir(), "ivy-wf-"));
  const events: DaemonEvent[] = [];
  const asked: Array<{ system: string; prompt: string }> = [];
  const writer = {
    complete: async (call: { system: string; prompt: string }) => {
      asked.push(call);
      return answer;
    },
  } as unknown as Writer;
  const config = {
    writes_first: true,
    writes_first_quiet: "22:00-09:00",
    writes_first_per_day: 1,
    max_steps: 25,
  } as ReturnType<typeof loadConfig>["agent"];
  let now = at("2026-10-29T20:00");
  const opts = {
    config,
    sessionsDir: dir,
    model: "m",
    writer,
    publish: (e: DaemonEvent) => events.push(e),
    now: () => now,
  };
  let handled = 0;
  const reminder: Reminder = {
    id: "follow|x",
    title: '周四面试后问问结果；说很紧张 ("周四下午三点面试，好紧张")',
    from: "ivy",
    handled: () => {
      handled++;
    },
  };
  return {
    dir,
    events,
    asked,
    config,
    opts,
    reminder,
    handled: () => handled,
    setNow: (d: Date) => {
      now = d;
    },
  };
}

test("a follow-up come due becomes her message in a conversation of its own, with a notification", async () => {
  const t = setup();
  await writeFirst(t.opts, t.reminder);
  const [mine] = Session.list(t.dir);
  expect(mine).toMatchObject({ fromIvy: true, turns: 0, preview: "面试怎么样了？" });
  const loaded = Session.load(t.dir, mine?.id ?? "");
  expect(loaded.messages.map((m) => m.role)).toEqual(["user", "assistant"]); // a user turn first
  expect(t.events.map((e) => e.type)).toEqual(["session", "reminder"]);
  expect(t.events[1]).toMatchObject({
    data: { title: "Ivy", body: "面试怎么样了？" },
    notify: true,
  });
  expect(t.asked[0]?.system).toContain("周四面试后问问结果");
  expect(t.handled()).toBe(1);
});

test("already talked about: nothing is sent, and it is done with", async () => {
  const t = setup("NOTHING");
  await writeFirst(t.opts, t.reminder);
  expect(Session.list(t.dir)).toEqual([]);
  expect(t.events).toEqual([]);
  expect(t.handled()).toBe(1);
});

test("she waits: switched off, quiet hours, the day's cap, unanswered, the user just here", async () => {
  const t = setup();
  t.config.writes_first = false;
  expect(mayWrite(t.opts, at("2026-10-29T20:00"))).toBe("writing first is off");
  t.config.writes_first = true;
  expect(mayWrite(t.opts, at("2026-10-29T23:30"))).toBe("quiet hours");
  expect(mayWrite(t.opts, at("2026-10-30T08:59"))).toBe("quiet hours");

  // Hers, unanswered: not chased while recent, let go after a few days; one a day.
  await writeFirst(t.opts, t.reminder);
  const evening = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(20, 0, 0, 0);
    return d;
  };
  expect(mayWrite(t.opts, evening(1))).toBe("her last one is unanswered");
  expect(mayWrite(t.opts, evening(4))).toBeUndefined();
  t.config.writes_first_per_day = 0;
  expect(mayWrite(t.opts, evening(1))).toBe("enough for today");
  t.config.writes_first_per_day = 1;
  // The user here a moment ago: a conversation they're in brings it up instead.
  const talk = Session.create(t.dir, "m");
  talk.appendPrompt("hi", "");
  expect(mayWrite(t.opts, new Date(Date.now() + 10 * 60 * 1000))).toBeDefined();
  await writeFirst(t.opts, t.reminder);
  expect(t.handled()).toBe(1); // waiting is not done
});

test("quiet hours may cross midnight", () => {
  expect(inQuiet("22:00-09:00", at("2026-10-29T03:00"))).toBe(true);
  expect(inQuiet("22:00-09:00", at("2026-10-29T12:00"))).toBe(false);
  expect(inQuiet("13:00-14:00", at("2026-10-29T13:30"))).toBe(true);
});
