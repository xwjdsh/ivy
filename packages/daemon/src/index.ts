import { createLogger, type Paths } from "@ivy/kernel";
import { startDaemon } from "./server.ts";

export {
  type Daemon,
  type DaemonEvent,
  DaemonRunningError,
  isAlive,
  startDaemon,
} from "./server.ts";

/** `ivy daemon`: serve until SIGINT or SIGTERM, then remove the socket and exit. */
export async function runDaemon(paths: Paths): Promise<void> {
  const daemon = await startDaemon(paths);
  const log = createLogger("daemon");
  await new Promise<void>((resolve) => {
    const stop = (signal: string) => {
      log.info(`stopping (${signal})`);
      resolve();
    };
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
  });
  await daemon.stop();
}
