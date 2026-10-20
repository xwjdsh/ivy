import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeVersion, type Daemon, startDaemon } from "@ivy/daemon";
import { resolvePaths } from "@ivy/kernel";
import { DaemonClient, ensureDaemon } from "./client.ts";

const running: Daemon[] = [];
afterEach(async () => {
  for (const d of running.splice(0)) await d.stop();
});

const paths = () => resolvePaths(mkdtempSync(join(tmpdir(), "ivy-c-")));

test("a daemon running this code is used as it is", async () => {
  const p = paths();
  running.push(await startDaemon(p, undefined, { code: codeVersion(), onDemand: true }));
  await ensureDaemon(p); // returns without starting or stopping anything
  expect(running[0]?.clients).toBe(0);
});

test("the app's daemon is used even when it runs other code of the same protocol", async () => {
  const p = paths();
  running.push(await startDaemon(p, undefined, { code: "older", onDemand: false }));
  await ensureDaemon(p); // not replaced: the app owns it
});

test("a client whose daemon went away brings one up and reconnects", async () => {
  const p = paths();
  const first = await startDaemon(p);
  let restarts = 0;
  const client = new DaemonClient(p.daemonSocket, async () => {
    restarts++;
    running.push(await startDaemon(p));
  });
  let connects = 0;
  const stop = new AbortController();
  const following = client.follow(
    () => {},
    stop.signal,
    () => connects++,
  );
  while (connects < 1) await Bun.sleep(10);
  await first.stop(); // the app quit, or the daemon idled out
  while (connects < 2) await Bun.sleep(10);
  expect(restarts).toBe(1);
  stop.abort();
  await following;
});
