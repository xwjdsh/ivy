// The `ivy` command's side of the daemon's protocol (docs/design/interfaces.md): requests over the
// daemon's socket, its event stream, and starting a daemon when none answers.

import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { codeVersion, health } from "@ivy/daemon";
import type { Paths } from "@ivy/kernel";
import {
  type CommandInfo,
  type CommandResult,
  type DaemonState,
  type Display,
  type ErrorBody,
  type PermissionAnswer,
  PROTOCOL_VERSION,
  type Prompt,
  type Report,
  readEvents,
  type SessionEvent,
  type SessionSummary,
  type SessionView,
  type Switched,
} from "@ivy/protocol";

/** A daemon `ivy` starts exits once no client has used it for this long. */
export const ON_DEMAND_IDLE_MS = 30 * 60 * 1000;
/** How long a starting daemon gets to answer. */
const START_TIMEOUT_MS = 15_000;

/** A request the daemon refused; the message is its reason. */
export class DaemonError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class DaemonClient {
  constructor(
    readonly socket: string,
    /** Bring a daemon up when the stream finds none (it stopped, or idled out). */
    private readonly ensure?: () => Promise<void>,
  ) {}

  protected async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`http://ivy${path}`, {
      method,
      unix: this.socket,
      ...(body !== undefined && {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        message = (JSON.parse(text) as ErrorBody).error ?? message;
      } catch {
        // not JSON
      }
      throw new DaemonError(res.status, message);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  state = () => this.request<DaemonState>("GET", "/state");
  models = () => this.request<{ models: string[]; errors: string[] }>("GET", "/models");
  setModel = (model: string) => this.request<Switched>("PUT", "/model", { model });
  setEffort = (effort: string) => this.request<Switched>("PUT", "/effort", { effort });
  commands = () => this.request<CommandInfo[]>("GET", "/commands");

  sessions = () => this.request<SessionSummary[]>("GET", "/sessions");
  async createSession(display: Display = "markdown"): Promise<string> {
    return (await this.request<{ id: string }>("POST", "/sessions", { display })).id;
  }
  session = (id: string) => this.request<SessionView>("GET", `/sessions/${id}`);
  send = (id: string, text: string) =>
    this.request<Prompt>("POST", `/sessions/${id}/prompts`, { text });
  withdraw = (id: string, promptId: string) =>
    this.request<void>("DELETE", `/sessions/${id}/prompts/${promptId}`);
  interrupt = (id: string, clearQueue = true) =>
    this.request<void>("POST", `/sessions/${id}/interrupt`, { clearQueue });
  answer = (askId: string, choice: PermissionAnswer) =>
    this.request<void>("POST", `/permissions/${askId}`, { choice });
  runCommand = (id: string, name: string, args: string) =>
    this.request<CommandResult>("POST", `/sessions/${id}/commands`, { name, args });
  usage = (id: string) => this.request<Report>("GET", `/sessions/${id}/usage`);
  status = (id: string) => this.request<Report>("GET", `/sessions/${id}/status`);

  /**
   * Follow the daemon's session events until `signal` aborts, reconnecting if the stream
   * drops. `onConnect` runs each time the stream is (re)opened, before any event, so a
   * client can reload what it shows. Resolves when `signal` aborts.
   */
  async follow(
    onEvent: (event: SessionEvent) => void,
    signal: AbortSignal,
    onConnect: () => void = () => {},
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        const res = await fetch("http://ivy/events", { unix: this.socket, signal });
        if (!res.body) throw new Error("no event stream");
        await readEvents(res.body, (type, data) => {
          if (type === "connected") onConnect();
          else if (type === "session") onEvent(JSON.parse(data) as SessionEvent);
        });
      } catch {
        // the daemon went away or the client stopped; retry below unless stopping
      }
      if (signal.aborted) break;
      // The daemon stopped (the app quit, or it idled out): start one, as `ivy` does.
      await this.ensure?.().catch(() => {});
      await Bun.sleep(500);
    }
  }
}

/** The daemon for this data folder, brought up first if need be (see ensureDaemon). */
export async function connect(paths: Paths): Promise<DaemonClient> {
  await ensureDaemon(paths, { replace: true });
  // Later, when the stream finds no daemon, start one; but never replace one: by then this
  // process may be the older code (a TUI left open across an update or an edit).
  return new DaemonClient(paths.daemonSocket, () => ensureDaemon(paths, { replace: false }));
}

/**
 * Make sure a daemon this ivy can use answers on the socket:
 * - none: start one in the background (it exits on its own once unused);
 * - one exiting: wait for it to go, then start one;
 * - one running other code that `ivy` started: with `replace` (as `ivy` starts, holding
 *   the newest code), stop it and start one with this code; else use it;
 * - one running other code that the app started: use it.
 * Either way, one that speaks another protocol is refused with what to do.
 */
export async function ensureDaemon(paths: Paths, opts: { replace: boolean }): Promise<void> {
  const socket = paths.daemonSocket;
  const deadline = Date.now() + START_TIMEOUT_MS;
  let started = false;
  /** The stale daemon stopped here, until it is gone. */
  let stopped: number | undefined;
  for (;;) {
    const h = await health(socket);
    if (h && !h.draining && h.pid !== stopped) {
      const sameProtocol = h.protocol === PROTOCOL_VERSION;
      if (sameProtocol && h.code === codeVersion()) return;
      if (opts.replace && h.onDemand && stopped === undefined) {
        stopped = h.pid;
        process.kill(h.pid, "SIGTERM"); // it interrupts running turns and writes them
      } else if (sameProtocol) {
        return;
      } else {
        throw new Error(
          `Ivy's daemon (pid ${h.pid}) speaks protocol ${h.protocol}, this ivy speaks ${PROTOCOL_VERSION}. Restart the Ivy app to update it.`,
        );
      }
    } else if (!h && !started) {
      startDaemon(paths);
      started = true;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Ivy's daemon didn't start. Its log: ${join(paths.daemonState, "daemon.log")}`,
      );
    }
    await Bun.sleep(100);
  }
}

/** Start `ivy daemon` in the background, detached, its output in the daemon's state folder. */
function startDaemon(paths: Paths): void {
  mkdirSync(paths.daemonState, { recursive: true });
  const out = openSync(join(paths.daemonState, "daemon.log"), "a");
  // A compiled ivy is its own executable; in development it is bun running main.ts.
  const self = Bun.main.startsWith("/$bunfs/") ? [] : [Bun.main];
  const child = spawn(
    process.execPath,
    [...self, "daemon", "--idle-exit", String(ON_DEMAND_IDLE_MS)],
    {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, IVY_HOME: paths.home },
    },
  );
  child.unref();
}
