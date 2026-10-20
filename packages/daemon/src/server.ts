// The daemon's local server: HTTP on a Unix socket (~/.ivy/daemon.sock), readable and
// writable by the user alone. No TCP port, so other users and web pages can't reach it,
// and there is no port to find or to clash. Events go out as Server-Sent Events.
//
// One daemon at a time: a live socket (one that answers /health) means another daemon
// runs; a dead one is left over from a crash and is replaced.

import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createLogger, type Paths } from "@ivy/kernel";
import { type Health, PROTOCOL_VERSION } from "@ivy/protocol";

/** Something the daemon tells its clients, e.g. a reminder that is due. */
export interface DaemonEvent {
  type: string;
  data: unknown;
  /**
   * Keep it for the next client when none listens (a reminder, which must not be lost
   * while the app starts). A session's events aren't kept: a client opening the session
   * reads where it stands.
   */
  hold?: boolean;
}

/** The daemon's other requests (sessions, prompts, …); undefined for a path it doesn't serve. */
export type Routes = (req: Request) => Promise<Response | undefined> | Response | undefined;

export interface Daemon {
  /** Send an event to every connected client. */
  publish(event: DaemonEvent): void;
  /** Stop serving and remove the socket. */
  stop(): Promise<void>;
}

/**
 * A comment line this often keeps an event stream open: Bun closes a connection idle for
 * 10 s (its default idleTimeout). On a Unix socket the per-request way out,
 * server.timeout(req, 0), does nothing (https://github.com/oven-sh/bun/issues/43816), and a
 * server-wide idleTimeout works but is missing from the types
 * (https://github.com/oven-sh/bun/issues/46138) and would drop the timeout for every
 * request. A heartbeat inside that limit needs no setting at all, leaves the timeout
 * guarding every other request, and finds clients that went away.
 */
const HEARTBEAT_MS = 5_000;
/**
 * Events to hold, published while no client listens (the app not yet connected, or
 * restarting), are kept, at most this many and this long, for the next client that connects.
 */
const HELD_MAX = 20;
const HELD_MS = 60 * 60 * 1000;
/**
 * A client that stops reading is dropped once this many chunks wait for it, so a stuck
 * client can't make the daemon's memory grow; it reconnects when it reads again.
 */
const CLIENT_QUEUE_MAX = 100;
/** The first event on every stream: the client knows it is subscribed (comments aren't seen). */
const CONNECTED = "event: connected\ndata: {}\n\n";

const log = createLogger("daemon");

export class DaemonRunningError extends Error {}

/** macOS takes Unix socket paths of at most 103 bytes (104 with the final NUL). */
export const MAX_SOCKET_PATH = 103;

/** Start serving on the socket; throws DaemonRunningError if a daemon already answers there. */
export async function startDaemon(paths: Paths, routes?: Routes): Promise<Daemon> {
  const socket = paths.daemonSocket;
  const length = Buffer.byteLength(socket);
  if (length > MAX_SOCKET_PATH) {
    throw new Error(
      `The daemon's socket path is too long (${length} bytes; macOS allows ${MAX_SOCKET_PATH}): ${socket}. Use a shorter IVY_HOME.`,
    );
  }
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
        if ((client.desiredSize ?? 0) < -CLIENT_QUEUE_MAX) {
          clients.delete(client);
          client.close();
          log.warn("dropped an event client that stopped reading");
          continue;
        }
        client.enqueue(bytes);
      } catch {
        clients.delete(client); // the client went away
      }
    }
  };
  const heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
  let held: Array<{ chunk: string; at: number }> = [];

  const server = Bun.serve({
    unix: socket,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (req.method === "GET" && pathname === "/health") {
        const health: Health = {
          ok: true,
          pid: process.pid,
          startedAt,
          protocol: PROTOCOL_VERSION,
        };
        return Response.json(health);
      }
      if (req.method === "GET" && pathname === "/events") {
        let self: ReadableStreamDefaultController<Uint8Array> | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            self = controller;
            clients.add(controller);
            controller.enqueue(encoder.encode(CONNECTED));
            const fresh = held.filter((h) => Date.now() - h.at < HELD_MS);
            held = [];
            for (const h of fresh) controller.enqueue(encoder.encode(h.chunk));
          },
          cancel() {
            if (self) clients.delete(self);
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache, no-transform",
          },
        });
      }
      return (await routes?.(req)) ?? Response.json({ error: "Not found" }, { status: 404 });
    },
  });
  chmodSync(socket, 0o600);
  log.info(`listening on ${socket}`);

  return {
    publish(event) {
      const chunk = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
      if (clients.size > 0) send(chunk);
      else if (event.hold) held = [...held, { chunk, at: Date.now() }].slice(-HELD_MAX);
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
