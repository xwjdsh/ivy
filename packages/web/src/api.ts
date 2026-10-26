// The chat window's side of the daemon's protocol (DESIGN.md §5.7). The page is the app's
// own; its requests go to ivy://, a scheme the app forwards to the daemon's socket.

import {
  type CommandInfo,
  type CommandResult,
  type DaemonState,
  type ErrorBody,
  type PermissionAnswer,
  type Prompt,
  readEvents,
  type SessionEvent,
  type SessionSummary,
  type SessionView,
  type Settings,
  type Switched,
  type Uploaded,
} from "@ivy/protocol";

/** The daemon, through the app (app/window.go). */
const DAEMON = "ivy://localhost";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  // A Blob goes as its bytes (an image), anything else as JSON. Read into an ArrayBuffer
  // first: the web view hands an ivy:// request a Blob body empty.
  const res = await fetch(DAEMON + path, {
    method,
    ...(body instanceof Blob
      ? { body: await body.arrayBuffer(), headers: { "content-type": body.type } }
      : body !== undefined && {
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
    throw new Error(message);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  state: () => request<DaemonState>("GET", "/state"),
  models: () => request<{ models: string[]; errors: string[] }>("GET", "/models"),
  setModel: (model: string) => request<Switched>("PUT", "/model", { model }),
  /** "" for none: side work then runs on the model. */
  setHelperModel: (model: string) => request<Switched>("PUT", "/helper-model", { model }),
  setEffort: (effort: string) => request<Switched>("PUT", "/effort", { effort }),
  sessions: () => request<SessionSummary[]>("GET", "/sessions"),
  createSession: async () => (await request<{ id: string }>("POST", "/sessions", {})).id,
  session: (id: string) => request<SessionView>("GET", `/sessions/${id}`),
  /** The session's file goes to the trash folder (DESIGN.md §5.7). */
  deleteSession: (id: string) => request<void>("DELETE", `/sessions/${id}`),
  settings: () => request<Settings>("GET", "/settings"),
  addProvider: (p: {
    name: string;
    type: string;
    base_url: string;
    key: string;
    models: string[];
  }) => request<Settings>("POST", "/providers", p),
  updateProvider: (name: string, edit: { base_url?: string; models?: string[] }) =>
    request<Settings>("PUT", `/providers/${encodeURIComponent(name)}`, edit),
  removeProvider: (name: string) =>
    request<Settings>("DELETE", `/providers/${encodeURIComponent(name)}`),
  /** Without a key, the one in config.toml moves to the Keychain. */
  setKey: (name: string, key?: string) =>
    request<Settings>("PUT", `/providers/${encodeURIComponent(name)}/key`, key ? { key } : {}),
  removeKey: (name: string) =>
    request<Settings>("DELETE", `/providers/${encodeURIComponent(name)}/key`),
  /** The models an endpoint lists with a key (or `name`'s own), nothing saved; `unlisted`, why
   * one that took the key listed none. */
  testProvider: (t: { name?: string; type: string; base_url: string; key: string }) =>
    request<{ models: string[]; unlisted?: string }>("POST", "/provider-test", t),
  // The app's own settings, answered by the app (app/settings.go), not the daemon.
  login: async () => (await request<{ enabled: boolean }>("GET", "/app/login")).enabled,
  setLogin: async (enabled: boolean) =>
    (await request<{ enabled: boolean }>("PUT", "/app/login", { enabled })).enabled,
  command: () => request<{ installed: boolean; path: string }>("GET", "/app/command"),
  installCommand: () => request<{ installed: boolean; path: string }>("POST", "/app/command"),
  /** Open config.toml in the text editor, or Ivy's folder or logs in Finder. */
  open: (what: "config" | "home" | "logs") => request<void>("POST", "/app/open", { what }),
  /** The app's own setting, answered by the app (app/appearance.go), not the daemon. */
  appearance: async () =>
    (await request<{ appearance: Appearance }>("GET", "/app/appearance")).appearance,
  setAppearance: async (appearance: Appearance) =>
    (await request<{ appearance: Appearance }>("PUT", "/app/appearance", { appearance }))
      .appearance,
  /** What the plugins add to the command list. */
  commands: () => request<CommandInfo[]>("GET", "/commands"),
  /** A plugin command run outside a conversation, e.g. /remembered for her card's page. */
  run: (name: string, args = "") => request<CommandResult>("POST", "/commands", { name, args }),
  send: (id: string, text: string, images: string[] = []) =>
    request<Prompt>("POST", `/sessions/${id}/prompts`, { text, images }),
  /** An image attached to a message, kept by the daemon until the message names it. */
  upload: async (image: Blob) => (await request<Uploaded>("POST", "/images", image)).name,
  withdraw: (id: string, promptId: string) =>
    request<void>("DELETE", `/sessions/${id}/prompts/${promptId}`),
  interrupt: (id: string) =>
    request<void>("POST", `/sessions/${id}/interrupt`, { clearQueue: true }),
  answer: (askId: string, choice: PermissionAnswer) =>
    request<void>("POST", `/permissions/${askId}`, { choice }),
};

/** Light or dark, or the system's; the page follows it through prefers-color-scheme. */
export type Appearance = "system" | "light" | "dark";

/** An image sent in a session, to show. */
export const imageUrl = (sessionId: string, name: string) =>
  `${DAEMON}/sessions/${sessionId}/images/${name}`;

const RETRY_MS = 1000;

/**
 * Follow the daemon's session events until `signal` aborts, reconnecting when the stream
 * drops (the daemon restarted). `onConnect(true)` runs each time it is (re)opened, before
 * any event, so what is shown can be read afresh; `onConnect(false)` when it drops.
 */
export async function follow(
  onEvent: (event: SessionEvent) => void,
  onConnect: (connected: boolean) => void,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const res = await fetch(`${DAEMON}/events`, { signal });
      if (!res.ok || !res.body) throw new Error(`events: ${res.status}`);
      await readEvents(res.body, (type, data) => {
        if (type === "connected") onConnect(true);
        else if (type === "session") onEvent(JSON.parse(data) as SessionEvent);
      });
    } catch {
      // the daemon went away, or the page stopped following
    }
    if (signal.aborted) break;
    onConnect(false);
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
}
