// A conversation summed up once it is let go (DESIGN.md §5.4, §11 M3): its title, what
// mattered and what was left open, by the helper model, kept beside the session as metadata,
// not memory. The next conversation starts from it.

import { rmSync } from "node:fs";
import {
  type ConversationHistory,
  LEFT_OUT,
  localDate,
  localTime,
  type SessionPoints,
} from "@ivy/plugin-api";
import type { Helper } from "./helper.ts";
import { createLogger, errorMessage } from "./log.ts";
import POINTS from "./prompts/points.md" with { type: "text" };
import { pointsFile, savePoints } from "./session.ts";

/** What the helper reads of a long conversation: its end, where it was left. */
const MAX_CHARS = 40_000;
/** A conversation with fewer of the user's messages is too slight to sum up. */
const MIN_PROMPTS = 2;
/** Recent conversations looked at on startup, for one let go by Ivy stopping, not idling. */
const ON_START = 3;

const log = createLogger("points");

/** Sums up conversations as they are let go, and knows which it is still at. */
export class Points {
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly dir: string,
    private readonly history: ConversationHistory,
    private readonly helper: Helper,
  ) {}

  /** The recent conversations not summed up through their end: those Ivy stopped in. */
  catchUp(): void {
    for (const { id } of this.history.sessions().slice(0, ON_START)) void this.sumUp(id);
  }

  /**
   * Sum up a conversation, unless it is summed up through its last message already, or too slight.
   * Ivy's replies after outside content are marked as left out
   * (docs/design/security.md#a-turn-that-read-outside-content). Never throws: a conversation
   * without points is only one the next can't pick up from.
   */
  sumUp(id: string): Promise<void> {
    const running = this.running.get(id);
    if (running) return running;
    const work = this.sum(id).finally(() => this.running.delete(id));
    this.running.set(id, work);
    return work;
  }

  /**
   * A part of the conversation was taken back: its points go, once any summing up under way
   * is done (it read the history before the part was marked), to be summed up again
   * without it when the conversation is let go.
   */
  async discard(id: string): Promise<void> {
    await this.running.get(id);
    rmSync(pointsFile(this.dir, id), { force: true });
  }

  /** Done when the summing up under way is, for a new conversation to start from it. */
  async settled(): Promise<void> {
    await Promise.all(this.running.values());
  }

  private async sum(id: string): Promise<void> {
    try {
      const messages = this.history.messages(id);
      const last = messages.at(-1);
      if (!last || messages.filter((m) => m.role === "user").length < MIN_PROMPTS) return;
      if ((this.history.points(id)?.through ?? "") >= last.ts) return;
      // A reply after outside content is left out, but not its being there: the question was
      // answered, and isn't left open.
      const transcript = messages
        .map((m) => {
          const text = m.outside ? LEFT_OUT : m.text;
          return `${m.role === "user" ? "User" : "Ivy"} (${stamp(new Date(m.ts))}): ${text}`;
        })
        .join("\n\n")
        .slice(-MAX_CHARS);
      const answer = await this.helper.complete({
        system: POINTS.trim(),
        // The task again after the conversation, so a short one isn't taken for a question.
        prompt: `<conversation>\n${transcript}\n</conversation>\n\nSum up the conversation above as the JSON described. Don't answer it.`,
        maxTokens: 800,
      });
      const points = parsePoints(answer);
      if (!points) {
        log.warn(`no points for ${id}: the helper's answer wasn't the JSON asked for`);
        return;
      }
      savePoints(this.dir, id, { ...points, through: last.ts });
    } catch (err) {
      log.warn(`no points for ${id}`, errorMessage(err));
    }
  }
}

/** "2026-10-23 21:40", in the user's time, as the conversation happened. */
function stamp(d: Date): string {
  return `${localDate(d)} ${localTime(d)}`;
}

/** The helper's JSON, checked, or undefined. */
export function parsePoints(answer: string): Omit<SessionPoints, "through"> | undefined {
  const json = answer.slice(answer.indexOf("{"), answer.lastIndexOf("}") + 1);
  try {
    const { title, points, open } = JSON.parse(json) as Record<string, unknown>;
    const lines = (v: unknown, max: number) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max) : [];
    if (typeof title !== "string" || !title.trim()) return undefined;
    return { title: title.trim(), points: lines(points, 5), open: lines(open, 3) };
  } catch {
    return undefined;
  }
}
