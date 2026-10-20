// The daemon's local server: HTTP on a Unix socket (~/.ivy/daemon.sock), readable and
// writable by the user alone. No TCP port, so other users and web pages can't reach it,
// and there is no port to find or to clash. Events go out as Server-Sent Events.
//
// One daemon at a time: a live socket (one that answers /health) means another daemon
// runs; a dead one is left over from a crash and is replaced.

import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createLogger, type Paths } from "@ivy/kernel";

/** Something the daemon tells its clients, e.g. a reminder that is due. */
export interface DaemonEvent {
  type: string;
  data: unknown;
}

export interface Daemon {
  /** Send an event to every connected client. */
  publish(event: DaemonEvent): void;
  /** Stop serving and remove the socket. */
  stop(): Promise<void>;
}

/** Comment lines keep idle event streams open through any timeout on the way. */
const HEARTBEAT_MS = 15_000;

const log = createLogger("daemon");

export class DaemonRunningError extends Error {}

/** Start serving on the socket; throws DaemonRunningError if a daemon already answers there. */
export async function startDaemon(paths: Paths): Promise<Daemon> {
  const socket = paths.daemonSocket;
  if (existsSync(socket)) {
    if (await isAlive(socket)) {
      throw new DaemonRunningError(`Ivy's daemon is already running (${socket}).`);
    }
    unlinkSync(socket); // left over from a daemon that didn't stop cleanly
  }

  const startedAt = new Date().toISOString();
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  const send = (chunk: string) => {
    const bytes = encoder.encode(chunk);
    for (const client of clients) {
      try {
        client.enqueue(bytes);
      } catch {
        clients.delete(client); // the client went away
      }
    }
  };
  const heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);

  const server = Bun.serve({
    unix: socket,
    fetch(req, srv) {
      const { pathname } = new URL(req.url);
      if (req.method === "GET" && pathname === "/health") {
        return Response.json({ ok: true, pid: process.pid, startedAt });
      }
      if (req.method === "GET" && pathname === "/events") {
        srv.timeout(req, 0); // the stream stays open; the idle timeout would cut it
        let self: ReadableStreamDefaultController<Uint8Array> | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            self = controller;
            clients.add(controller);
            controller.enqueue(encoder.encode(": connected\n\n"));
          },
          cancel() {
            if (self) clients.delete(self);
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  chmodSync(socket, 0o600);
  log.info(`listening on ${socket}`);

  return {
    publish(event) {
      send(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    },
    async stop() {
      clearInterval(heartbeat);
      for (const client of clients) {
        try {
          client.close();
        } catch {
          // already closed
        }
      }
      clients.clear();
      await server.stop(true);
      if (existsSync(socket)) unlinkSync(socket);
    },
  };
}

/** Whether a daemon answers on this socket. */
export async function isAlive(socket: string): Promise<boolean> {
  try {
    const res = await fetch("http://localhost/health", {
      unix: socket,
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
