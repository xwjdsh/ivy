import { expect, test } from "bun:test";
import type { SessionSummary } from "@ivy/protocol";
import { type Chat, emptyChat } from "./chat.ts";
import { presence } from "./presence.ts";

const summary = (id: string, busy: boolean): SessionSummary => ({
  id,
  createdAt: "2026-10-20T09:00:00.000Z",
  updatedAt: "2026-10-20T09:00:00.000Z",
  turns: 1,
  preview: "",
  busy,
});

test("presence follows what the daemon reports, nothing more", () => {
  const prompt = { id: "p1", text: "hi" };
  const idle = emptyChat("a");
  const running: Chat = { ...idle, running: prompt };
  expect(presence(idle, [], false)).toEqual({ tone: "away", text: "Away" });
  expect(presence(idle, [], true)).toEqual({ tone: "here", text: "Here" });
  // Off the record shows where "Here" would; what she is doing still shows as itself.
  expect(presence(idle, [], true, true)).toEqual({ tone: "off", text: "Off the record" });
  expect(presence(running, [], true, true).text).toBe("Thinking");
  expect(presence(running, [], true).text).toBe("Thinking");
  expect(presence({ ...running, streaming: "Hel" }, [], true).text).toBe("Writing");
  const tool: Chat = {
    ...running,
    items: [
      {
        kind: "tool",
        id: "t1",
        name: "memory__search",
        label: { plugin: "memory", text: "dentist" },
        input: {},
        result: "",
        isError: false,
        running: true,
      },
    ],
  };
  expect(presence(tool, [], true)).toEqual({ tone: "busy", text: "Using memory" });
  expect(presence({ ...tool, permission: {} as Chat["permission"] }, [], true).tone).toBe(
    "waiting",
  );
  // Another chat she's busy in counts; the one shown is judged by its own state.
  expect(presence(idle, [summary("b", true)], true).text).toBe("Busy in another chat");
  expect(presence(idle, [summary("a", true)], true).text).toBe("Here");
});
