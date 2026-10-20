import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths } from "@ivy/kernel";
import { type Daemon, DaemonRunningError, isAlive, startDaemon } from "./server.ts";

const running: Daemon[] = [];
afterEach(async () => {
  for (const d of running.splice(0)) await d.stop();
});

const paths = () => resolvePaths(mkdtempSync(join(tmpdir(), "ivy-d-")));
const start = async (p = paths()) => {
  const d = await startDaemon(p);
  running.push(d);
  return { d, p };
};
const get = (socket: string, path: string) => fetch(`http://localhost${path}`, { unix: socket });

test("serves /health on the socket, which only the user can use", async () => {
  const { p } = await start();
  const body = (await (await get(p.daemonSocket, "/health")).json()) as {
    ok: boolean;
    pid: number;
  };
  expect(body).toMatchObject({ ok: true, pid: process.pid });
  expect(statSync(p.daemonSocket).mode & 0o777).toBe(0o600);
  expect((await get(p.daemonSocket, "/nope")).status).toBe(404);
});

test("one daemon at a time; a socket left by a crash is replaced", async () => {
  const { p } = await start();
  await expect(startDaemon(p)).rejects.toBeInstanceOf(DaemonRunningError);

  const stale = paths();
  writeFileSync(stale.daemonSocket, ""); // not a socket anyone answers on
  expect(await isAlive(stale.daemonSocket)).toBe(false);
  await start(stale);
  expect(await isAlive(stale.daemonSocket)).toBe(true);
});

test("published events reach every client of /events", async () => {
  const { d, p } = await start();
  const read = async () => {
    const res = await get(p.daemonSocket, "/events");
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    return res.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  };
  const readers = [await read(), await read()];
  const decoder = new TextDecoder();
  for (const r of readers)
    expect(decoder.decode((await r.read()).value)).toBe("event: connected\ndata: {}\n\n");

  d.publish({ type: "reminder", data: { text: "Pick up the parcel" } });
  for (const r of readers) {
    expect(decoder.decode((await r.read()).value)).toBe(
      'event: reminder\ndata: {"text":"Pick up the parcel"}\n\n',
    );
    await r.cancel();
  }
});

test("stop removes the socket", async () => {
  const { d, p } = await start();
  running.pop();
  await d.stop();
  expect(existsSync(p.daemonSocket)).toBe(false);
  expect(await isAlive(p.daemonSocket)).toBe(false);
});

test("events published while no client listens go to the next one that connects", async () => {
  const { d, p } = await start();
  d.publish({ type: "reminder", data: { title: "early" } });
  const res = await get(p.daemonSocket, "/events");
  const reader = res.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  let text = "";
  while (!text.includes("early")) text += new TextDecoder().decode((await reader.read()).value);
  expect(text).toContain('event: reminder\ndata: {"title":"early"}');
  await reader.cancel();
});

test("an event stream stays open past Bun's default idle timeout of 10 s", async () => {
  const { d, p } = await start();
  const res = await get(p.daemonSocket, "/events");
  const reader = res.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  await reader.read(); // the connected event
  await Bun.sleep(11_000);
  d.publish({ type: "reminder", data: { title: "late" } });
  // Heartbeats come before it; the stream is open if the event arrives at all.
  let text = "";
  while (!text.includes("late")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`the stream closed; got: ${text}`);
    text += new TextDecoder().decode(value);
  }
  expect(text).toContain(": ping");
  await reader.cancel();
}, 20_000);

test("a client that stops reading is dropped, not buffered without end", async () => {
  const { d, p } = await start();
  const res = await get(p.daemonSocket, "/events");
  const reader = res.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  // Never read: the daemon's queue for this client fills, then the client is closed.
  for (let i = 0; i < 5000; i++) d.publish({ type: "tick", data: { i, pad: "x".repeat(200) } });
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  expect(text).toContain("event: connected");
  expect(text).not.toContain('"i":4999');
});
