import { join } from "node:path";
import { createIvy, createLogger, type Paths } from "@ivy/kernel";
import type { IvyPlugin } from "@ivy/plugin-api";
import { api } from "./api.ts";
import { DISPLAY_INSTRUCTIONS } from "./display.ts";
import { startScheduler } from "./scheduler.ts";
import { type Daemon, startDaemon } from "./server.ts";
import { Sessions } from "./sessions.ts";

export { type Scheduler, startScheduler } from "./scheduler.ts";
export {
  type Daemon,
  type DaemonEvent,
  DaemonRunningError,
  isAlive,
  type Routes,
  startDaemon,
} from "./server.ts";
export { PERMISSION_TIMEOUT_MS, Sessions } from "./sessions.ts";
export { api };

/**
 * `ivy daemon`: load Ivy with its plugins, serve on the socket and run the scheduler until
 * SIGINT or SIGTERM, then remove the socket and exit.
 */
export async function runDaemon(paths: Paths, plugins: IvyPlugin[]): Promise<void> {
  // Permission prompts go to the clients following the session (see Sessions).
  let sessions: Sessions | undefined;
  const ivy = await createIvy({
    plugins,
    paths,
    confirm: (call) => (sessions ? sessions.confirm(call) : Promise.resolve("deny")),
    interfaceInstructions: DISPLAY_INSTRUCTIONS.markdown,
  });
  let daemon: Daemon | undefined;
  sessions = new Sessions({
    ivy,
    publish: (event) => daemon?.publish({ type: "session", data: event }),
  });
  daemon = await startDaemon(paths, api(ivy, sessions));
  const scheduler = startScheduler({
    stateFile: join(paths.daemonState, "scheduler.json"),
    reminders: (window) => ivy.plugins.reminders(window),
    publish: (event) => daemon.publish(event),
  });
  const log = createLogger("daemon");
  await new Promise<void>((resolve) => {
    const stop = (signal: string) => {
      log.info(`stopping (${signal})`);
      resolve();
    };
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
  });
  scheduler.stop();
  await daemon.stop();
  await ivy.plugins.teardown();
}
