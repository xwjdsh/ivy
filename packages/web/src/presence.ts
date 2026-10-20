// What Ivy is doing now, as the window shows it under her name. Only what the daemon reports:
// a status is never made up to look alive.

import type { SessionSummary } from "@ivy/protocol";
import type { Chat } from "./chat.ts";

export interface Presence {
  /** away: the daemon can't be reached; waiting: for the user's answer. */
  tone: "here" | "busy" | "waiting" | "away";
  text: string;
}

export function presence(
  chat: Chat | undefined,
  sessions: SessionSummary[],
  connected: boolean,
): Presence {
  if (!connected) return { tone: "away", text: "Away" };
  if (chat?.running) {
    if (chat.permission) return { tone: "waiting", text: "Waiting for your OK" };
    const tool = chat.items.findLast((i) => i.kind === "tool" && i.running);
    if (tool?.kind === "tool") return { tone: "busy", text: `Using ${tool.label.plugin}` };
    return { tone: "busy", text: chat.streaming ? "Writing" : "Thinking" };
  }
  if (sessions.some((s) => s.busy && s.id !== chat?.id)) {
    return { tone: "busy", text: "Busy in another chat" };
  }
  return { tone: "here", text: "Here" };
}

/** "Good morning" and so on, by the hour. */
export function greeting(now = new Date()): string {
  const h = now.getHours();
  if (h >= 5 && h < 12) return "Good morning";
  if (h >= 12 && h < 18) return "Good afternoon";
  if (h >= 18 && h < 23) return "Good evening";
  return "Up late?";
}
