import { join } from "node:path";
import { createIvy, createLogger, type Paths } from "@ivy/kernel";
import type { IvyPlugin } from "@ivy/plugin-api";
import { startScheduler } from "./scheduler.ts";
import { startDaemon } from "./server.ts";

export { type Scheduler, startScheduler } from "./scheduler.ts";
export {
  type Daemon,
  type DaemonEvent,
  DaemonRunningError,
  isAlive,
  startDaemon,
} from "./server.ts";

/**
 * `ivy daemon`: load Ivy with its plugins, serve on the socket and run the scheduler until
 * SIGINT or SIGTERM, then remove the socket and exit.
 */
export async function runDaemon(paths: Paths, plugins: IvyPlugin[]): Promise<void> {
  // No one is there to answer a permission prompt yet: anything that asks is refused.
  const ivy = await createIvy({ plugins, paths, confirm: async () => "deny" });
  const daemon = await startDaemon(paths);
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
