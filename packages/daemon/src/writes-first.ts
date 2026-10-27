// Ivy writes first (DESIGN.md §11, M3): a follow-up she noted from what the user told her,
// come due while they aren't talking with her, becomes a message of hers in a conversation
// of its own, with a notification. Only when she may: the switch on, outside quiet hours,
// under the day's cap, the user not just here (a conversation they are in brings it up
// itself), and her last such message answered (she never chases). The writer drops one the
// user already talked about since. Otherwise it waits for the next check, and memory lets
// it go a few days past its time.

import { type Config, Session, sessionHistory, type Writer } from "@ivy/kernel";
import { localDate, localTime, type Reminder, rank } from "@ivy/plugin-api";
import type { DaemonEvent } from "./server.ts";
import PROMPT from "./writes-first.md" with { type: "text" };

/** The writer's answer when the user already told her, or asking no longer makes sense. */
const NOTHING = "NOTHING";
/** Of what the user said lately, how much bears on the follow-up, at most. */
const MAX_SAID = 10;
const MAX_SAID_CHARS = 4000;
/** How far back what the user said is looked through. */
const LOOK_BACK_MS = 7 * 24 * 60 * 60 * 1000;
/** The user wrote this recently: they are here, and a conversation they're in brings it up. */
const HERE_MS = 60 * 60 * 1000;
/** Her unanswered message holds her back this long; after, it is let go, as a follow-up is. */
const UNANSWERED_MS = 3 * 24 * 60 * 60 * 1000;
/** Held back, she isn't asked again this soon: the check reads every conversation. */
const RECHECK_MS = 5 * 60 * 1000;
const heldBack = new WeakMap<WriteFirstOptions, number>();

export interface WriteFirstOptions {
  config: Config["agent"];
  sessionsDir: string;
  model: string;
  writer: Writer;
  publish(event: DaemonEvent): void;
  now?: () => Date;
}

/** Whether she may write now; why not, if not. */
export function mayWrite(opts: WriteFirstOptions, now: Date): string | undefined {
  const { config } = opts;
  if (!config.writes_first) return "writing first is off";
  if (inQuiet(config.writes_first_quiet, now)) return "quiet hours";
  const all = Session.list(opts.sessionsDir, Number.POSITIVE_INFINITY);
  const hers = all.filter((s) => s.fromIvy).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const today = localDate(now);
  const sent = hers.filter((s) => localDate(new Date(s.createdAt)) === today).length;
  if (sent >= config.writes_first_per_day) return "enough for today";
  const last = hers[0];
  if (last && last.turns === 0 && now.getTime() - Date.parse(last.createdAt) < UNANSWERED_MS) {
    return "her last one is unanswered";
  }
  const latest = all.find((s) => !s.fromIvy || s.turns > 0);
  if (latest && now.getTime() - Date.parse(latest.updatedAt) < HERE_MS) return "the user is here";
  return undefined;
}

/** Write her message for a follow-up, if she may now; mark it handled once sent or dropped. */
export async function writeFirst(opts: WriteFirstOptions, reminder: Reminder): Promise<void> {
  const now = (opts.now ?? (() => new Date()))();
  if (now.getTime() < (heldBack.get(opts) ?? 0)) return;
  if (mayWrite(opts, now)) {
    heldBack.set(opts, now.getTime() + RECHECK_MS);
    return;
  }
  const answer = (
    await opts.writer.complete({
      system: PROMPT.trim()
        .replace("{{now}}", `${localDate(now)} ${weekday(now)} ${localTime(now)}`)
        .replace("{{follow}}", reminder.title),
      prompt: context(opts.sessionsDir, reminder.title, now),
    })
  ).trim();
  if (answer && answer !== NOTHING) {
    const session = Session.create(opts.sessionsDir, opts.model, { fromIvy: true });
    session.appendOpening(
      answer,
      `Ivy wrote first, unprompted, on ${localDate(now)} at ${localTime(now)}, about something the user had told her.`,
    );
    opts.publish({ type: "session", data: { sessionId: session.id, type: "started" } });
    opts.publish({
      type: "reminder",
      data: { id: `ivy|${session.id}`, title: "Ivy", body: firstLine(answer) },
      notify: true,
    });
  }
  await reminder.handled?.();
}

/** What the user said lately that bears on it, and where the last conversation was left. */
function context(dir: string, follow: string, now: Date): string {
  const history = sessionHistory(dir);
  const since = now.getTime() - LOOK_BACK_MS;
  const said = history.sessions().flatMap(({ id, updatedAt }) =>
    Date.parse(updatedAt) < since
      ? []
      : history
          .messages(id)
          .filter((m) => m.role === "user" && Date.parse(m.ts) >= since)
          .map((m) => ({ ts: m.ts, entry: { text: m.text, tags: [] } })),
  );
  let used = 0;
  const lines = rank(said, follow, MAX_SAID)
    .map(({ item }) => item)
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .flatMap((m) => {
      const line = `- (${localDate(new Date(m.ts))} ${localTime(new Date(m.ts))}) ${m.entry.text}`;
      used += line.length;
      return used > MAX_SAID_CHARS ? [] : [line];
    });
  const last = history.sessions()[0];
  const points = last && history.points(last.id);
  return [
    `What they said since that may bear on it:\n${lines.join("\n") || "(nothing)"}`,
    points
      ? `Your last conversation: ${points.title}. ${[...points.points, ...points.open].join("; ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Whether now falls in a span "HH:MM-HH:MM", which may cross midnight. */
export function inQuiet(span: string, now: Date): boolean {
  const [from = "", to = ""] = span.split("-");
  const t = localTime(now);
  return from <= to ? t >= from && t < to : t >= from || t < to;
}

const weekday = (d: Date) => d.toLocaleDateString("en-US", { weekday: "long" });
const firstLine = (text: string) =>
  text
    .split("\n")
    .find((l) => l.trim())
    ?.trim() ?? text;
