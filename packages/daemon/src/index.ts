import { join } from "node:path";
import {
  clearUploads,
  createIvy,
  createLogger,
  type Ivy,
  type KeyStore,
  type ModelClient,
  type Paths,
  setLogLevel,
  setLogSink,
} from "@ivy/kernel";
import type { IvyPlugin } from "@ivy/plugin-api";
import { api } from "./api.ts";
import { startJobs } from "./jobs.ts";
import { startScheduler } from "./scheduler.ts";
import { type Daemon, startDaemon } from "./server.ts";
import { Sessions } from "./sessions.ts";
import { codeVersion } from "./version.ts";

// What other packages use: `ivy daemon` (runDaemon), a daemon to test against (serve,
// startDaemon), what a client checks (health, codeVersion), and the evals' display text.
export { DISPLAY_INSTRUCTIONS } from "./display.ts";
export { type Daemon, health, startDaemon } from "./server.ts";
export { codeVersion } from "./version.ts";

export interface ServeOptions {
  paths: Paths;
  plugins: IvyPlugin[];
  /** One client for every provider, instead of real ones (tests). */
  model?: ModelClient;
  /** Where API keys are kept; the Keychain on macOS by default. */
  keys?: KeyStore;
  permissionTimeoutMs?: number;
  /** The clock for sessions going idle (tests). */
  now?: () => number;
  /** Started by `ivy` on demand (see Health.onDemand). */
  onDemand?: boolean;
  /** See IvyOptions.sumUp. */
  sumUp?: boolean;
}

export interface Served {
  ivy: Ivy;
  sessions: Sessions;
  daemon: Daemon;
  /** Interrupt running turns, stop serving, and let plugins clean up. */
  stop(): Promise<void>;
}

/** Load Ivy with its plugins and serve its sessions on the socket (no scheduler). */
export async function serve(opts: ServeOptions): Promise<Served> {
  const ivy = await createIvy({
    plugins: opts.plugins,
    paths: opts.paths,
    model: opts.model,
    keys: opts.keys,
    sumUp: opts.sumUp,
  });
  // Images attached to a message never sent (DESIGN.md §5.4), now and every hour.
  clearUploads(ivy.paths.uploads);
  const clearing = setInterval(() => clearUploads(ivy.paths.uploads), 60 * 60 * 1000);
  clearing.unref();
  let daemon: Daemon | undefined;
  const live = new Sessions({
    ivy,
    publish: (event) => daemon?.publish({ type: "session", data: event }),
    permissionTimeoutMs: opts.permissionTimeoutMs,
    now: opts.now,
  });
  const started = await startDaemon(opts.paths, api(ivy, live), {
    code: codeVersion(),
    onDemand: opts.onDemand ?? false,
  });
  daemon = started;
  live.forgetLeftovers();
  return {
    ivy,
    sessions: live,
    daemon: started,
    async stop() {
      clearInterval(clearing);
      await live.close(); // running turns stop and write what they have
      await started.stop();
      await ivy.plugins.teardown();
    },
  };
}

export interface RunOptions {
  /**
   * Exit once no client has followed the event stream and nothing has run for this long:
   * for a daemon `ivy` started on demand. The app's daemon runs for as long as the app.
   */
  idleExitMs?: number;
}

/** How often an idle exit is checked for. */
const IDLE_CHECK_MS = 60 * 1000;

/**
 * `ivy daemon`: serve, and run the scheduler, until SIGINT or SIGTERM (or, with
 * `idleExitMs`, until idle that long), then remove the socket and exit.
 */
export async function runDaemon(
  paths: Paths,
  plugins: IvyPlugin[],
  opts: RunOptions = {},
): Promise<void> {
  // Its output goes to a log file (the app's, or ~/.ivy/daemon/daemon.log): what it did and
  // when (started, reminders announced, stopped), each line with its time.
  setLogLevel("info");
  setLogSink((line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`));
  const served = await serve({ paths, plugins, onDemand: opts.idleExitMs !== undefined });
  const { ivy, sessions, daemon } = served;
  const scheduler = startScheduler({
    stateFile: join(paths.daemonState, "scheduler.json"),
    reminders: (window) => ivy.plugins.reminders(window),
    publish: (event) => daemon.publish(event),
    canDeliver: () => daemon.notifiers > 0,
  });
  const jobs = startJobs({
    stateFile: join(paths.daemonState, "jobs.json"),
    jobs: ivy.plugins.jobs(),
  });
  const log = createLogger("daemon");
  await new Promise<void>((resolve) => {
    const stop = (why: string) => {
      log.info(`stopping (${why})`);
      daemon.drain(); // clients arriving now wait for it to go
      resolve();
    };
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
    const { idleExitMs } = opts;
    if (idleExitMs) {
      let activeAt = Date.now();
      setInterval(
        () => {
          if (daemon.clients > 0 || sessions.busy || jobs.busy) activeAt = Date.now();
          else if (Date.now() - activeAt >= idleExitMs) stop("idle");
        },
        Math.min(IDLE_CHECK_MS, idleExitMs),
      ).unref();
    }
  });
  scheduler.stop();
  jobs.stop();
  await served.stop();
}
