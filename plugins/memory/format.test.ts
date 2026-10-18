import { expect, test } from "bun:test";
import {
  formatEntry,
  normalizeTags,
  parseFile,
  parseLine,
  serializeFile,
  usage,
} from "./format.ts";

test("parses type, date, fields, flags and tags", () => {
  const { entry } = parseLine(
    "- [todo 2026-10-17 since:2026-10-01 due:2026-10-21 ext] Dentist at 15:00 #health #牙医",
  );
  expect(entry).toEqual({
    type: "todo",
    date: "2026-10-17",
    fields: { since: "2026-10-01", due: "2026-10-21" },
    ext: true,
    unknown: [],
    text: "Dentist at 15:00",
    tags: ["health", "牙医"],
  });
});

test("USER.md lines have a date but no type", () => {
  const { entry } = parseLine("- [2026-10-17] Prefers concise answers");
  expect(entry?.type).toBeUndefined();
  expect(entry?.date).toBe("2026-10-17");
  expect(entry?.text).toBe("Prefers concise answers");
});

test("hand-written lines never break: unknown tokens and bare entries are kept", () => {
  expect(parseLine("- Mei likes sushi").entry?.text).toBe("Mei likes sushi");
  const odd = parseLine("- [fact someday prio:high] Room #12 is mine");
  expect(odd.entry?.unknown).toEqual(["someday", "prio:high"]);
  expect(odd.entry?.text).toBe("Room #12 is mine"); // "#12" has no letter: not a tag
  expect(formatEntry(odd.entry as never)).toBe("- [fact someday prio:high] Room #12 is mine");
  expect(parseLine("# Memory").entry).toBeUndefined();
  expect(parseLine("").entry).toBeUndefined();
});

test("formatting writes fields in a fixed order", () => {
  const { entry } = parseLine(
    "- [fact replaced:2026-10-18 2026-10-01 since:2026-09-01] Lives in Osaka",
  );
  expect(formatEntry(entry as never)).toBe(
    "- [fact 2026-10-01 since:2026-09-01 replaced:2026-10-18] Lives in Osaka",
  );
});

test("files round-trip byte for byte; usage counts entries only", () => {
  const text = "# Memory\nMaintained by Ivy.\n\n- [fact 2026-10-17] A\n-  [weird]   spacing kept\n";
  const lines = parseFile(text);
  expect(serializeFile(lines)).toBe(text);
  expect(usage(lines)).toBe(
    "- [fact 2026-10-17] A".length + 1 + "-  [weird]   spacing kept".length + 1,
  );
  expect(serializeFile(parseFile(""))).toBe("");
});

test("tags are normalized", () => {
  expect(normalizeTags(["#牙医", "dental care", "#", "42", "health", "health"])).toEqual([
    "牙医",
    "dental-care",
    "health",
  ]);
});

test("due may carry a time; other dates may not", () => {
  expect(parseLine("- [todo 2026-10-18 due:2026-10-18T17:00] Parcel").entry?.fields.due).toBe(
    "2026-10-18T17:00",
  );
  expect(parseLine("- [fact 2026-10-18 since:2026-10-18T17:00] X").entry?.unknown).toEqual([
    "since:2026-10-18T17:00",
  ]);
});
