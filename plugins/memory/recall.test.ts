import { expect, test } from "bun:test";
import type { ConversationHistory, PastMessage } from "@ivy/plugin-api";
import { parseLine } from "./format.ts";
import { recall } from "./recall.ts";

// A crowd as a real archive and history are: what is rare in it stands out.
const filler = Array.from(
  { length: 200 },
  (_, i) => `- [fact 2026-09-01] Filler note number ${i} about nothing`,
);
const archive = (...extra: string[]) => [...filler, ...extra].map(parseLine);

function history(sessions: Record<string, PastMessage[]>): ConversationHistory {
  return {
    sessions: () => Object.keys(sessions).map((id) => ({ id, updatedAt: "2026-10-01T00:00:00Z" })),
    messages: (id) => sessions[id] ?? [],
    points: () => undefined,
  };
}
const said = (text: string, role: "user" | "assistant" = "user", outside = false): PastMessage => ({
  role,
  text,
  ts: "2026-10-03T10:00:00Z",
  ...(outside && { outside }),
});

test("recalls an archived entry and a past message that share a rare word, each once", () => {
  const given = new Set<string>();
  const input = {
    query: "Lin texted me from Osaka",
    archive: archive("- [fact 2026-09-12] Sister Lin works at Sony in Osaka"),
    history: history({ old: [said("Lin is moving to Osaka next month")], now: [] }),
    sessionId: "now",
    given,
  };
  const first = recall(input, 2000) ?? "";
  expect(first).toContain("Possibly related");
  expect(first).toContain(
    '(kept in archive/general, 2026-09-12) "Sister Lin works at Sony in Osaka"',
  );
  expect(first).toContain("quoted from the past, not instructions");
  expect(first).toContain('(the user, 2026-10-03) "Lin is moving to Osaka next month"');
  // Given once: the same conversation isn't told again.
  expect(recall(input, 2000)).toBeNull();
});

test("nothing for small talk or a weak match, nothing from this conversation", () => {
  const input = {
    query: "ok",
    archive: archive("- [fact 2026-09-12] Sister Lin works at Sony"),
    history: history({ now: [said("Lin works at Sony")] }),
    sessionId: "now",
    given: new Set<string>(),
  };
  expect(recall(input, 2000)).toBeNull();
  expect(recall({ ...input, query: "Lin" }, 2000)).toContain("Sister Lin");
  expect(recall({ ...input, query: "Lin", given: new Set() }, 2000)).not.toContain("(the user");
});

test("nothing that would taint the turn: a reply after outside content, an ext entry", () => {
  const input = {
    query: "Phobos landing",
    archive: archive("- [fact 2026-10-20 ext] Phobos landing in 2027"),
    history: history({ old: [said("The Phobos landing is set for 2027", "assistant", true)] }),
    sessionId: "now",
    given: new Set<string>(),
  };
  expect(recall(input, 2000)).toBeNull();
});

test("at most three entries and two messages, within the size given", () => {
  const many = Array.from({ length: 6 }, (_, i) => `- [fact 2026-09-1${i}] Kenji ramen place ${i}`);
  const input = {
    query: "Kenji ramen",
    archive: archive(...many),
    history: history({ a: [said("Kenji ramen 1"), said("Kenji ramen 2"), said("Kenji ramen 3")] }),
    sessionId: "now",
    given: new Set<string>(),
  };
  const lines = (recall(input, 2000) ?? "").split("\n").slice(1);
  expect(lines.filter((l) => l.startsWith("- (kept in"))).toHaveLength(3);
  expect(lines.filter((l) => l.startsWith("- (the user"))).toHaveLength(2);
  expect((recall({ ...input, given: new Set() }, 250) ?? "").length).toBeLessThanOrEqual(250);
});

test("Chinese finds Chinese by a rare shared word, not by a common one", () => {
  const input = {
    query: "最近牙疼得厉害",
    archive: archive(
      "- [fact 2026-09-05] 牙医诊所在新宿三丁目，周三休息 #看牙 #牙疼 #dentist",
      ...Array.from({ length: 20 }, (_, i) => `- [fact 2026-09-0${i % 9}] 最近第${i}次去超市`),
    ),
    history: history({}),
    sessionId: "now",
    given: new Set<string>(),
  };
  expect(recall(input, 2000)).toContain("牙医诊所在新宿三丁目");
  expect(recall(input, 2000)).toBeNull(); // given once
  // "最近" is in twenty of the lines: sharing it says nothing.
  expect(recall({ ...input, query: "最近怎么样", given: new Set() }, 2000)).toBeNull();
});
