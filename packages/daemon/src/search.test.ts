import { expect, test } from "bun:test";
import type { ConversationHistory, PastMessage } from "@ivy/plugin-api";
import { findMessages } from "./search.ts";

const said = (role: PastMessage["role"], text: string, ts: string): PastMessage => ({
  role,
  text,
  ts,
});

const history = (sessions: Record<string, PastMessage[]>): ConversationHistory => ({
  sessions: () => Object.keys(sessions).map((id) => ({ id, updatedAt: "" })),
  messages: (id) => sessions[id] ?? [],
  points: () => undefined,
});

test("finds messages holding every word, newest first, counted within their conversation", () => {
  const h = history({
    a: [
      said("user", "The Dentist is on Friday", "2026-10-20T09:00:00Z"),
      said("assistant", "Noted the dentist.", "2026-10-20T09:00:05Z"),
      said("user", "Moved the dentist to Monday", "2026-10-21T09:00:00Z"),
    ],
    b: [said("user", "dentist friday again", "2026-10-22T09:00:00Z")],
  });
  expect(findMessages(h, "dentist FRIDAY")).toEqual([
    {
      sessionId: "b",
      ts: "2026-10-22T09:00:00Z",
      role: "user",
      nth: 0,
      text: "dentist friday again",
    },
    {
      sessionId: "a",
      ts: "2026-10-20T09:00:00Z",
      role: "user",
      nth: 0,
      text: "The Dentist is on Friday",
    },
  ]);
  expect(findMessages(h, "dentist").find((m) => m.ts === "2026-10-21T09:00:00Z")?.nth).toBe(1);
  expect(findMessages(h, "  ")).toEqual([]);
});

test("shows what is around the match, cut short", () => {
  const text = `${"a ".repeat(40)}needle${" b".repeat(40)}`;
  const [hit] = findMessages(
    history({ a: [said("user", text, "2026-10-20T09:00:00Z")] }),
    "needle",
  );
  expect(hit?.text.startsWith("…")).toBe(true);
  expect(hit?.text.endsWith("…")).toBe(true);
  expect(hit?.text).toContain("needle");
});
