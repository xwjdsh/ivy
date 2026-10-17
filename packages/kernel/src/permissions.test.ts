import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setLogSink } from "./log.ts";
import { matchesAny, Permissions } from "./permissions.ts";

const file = () => join(mkdtempSync(join(tmpdir(), "ivy-perm-")), "permissions.json");
const rules = (r: Partial<{ allow: string[]; ask: string[]; deny: string[] }> = {}) => ({
  allow: [],
  ask: [],
  deny: [],
  ...r,
});

test("globs match whole tool names", () => {
  expect(matchesAny("memory__save", ["memory__*"])).toBe(true);
  expect(matchesAny("memory__save", ["memory"])).toBe(false);
  expect(matchesAny("a.b__c", ["a.b__*"])).toBe(true);
  expect(matchesAny("axb__c", ["a.b__*"])).toBe(false); // "." is literal
});

test("risk defaults: read runs, the rest asks", () => {
  const p = new Permissions(rules(), file());
  expect(p.decide("t__r", "read").decision).toBe("allow");
  for (const risk of ["write", "external", "dangerous"] as const) {
    expect(p.decide("t__x", risk).decision).toBe("ask");
  }
});

test("deny beats every allow; ask beats allow and a read label", () => {
  const p = new Permissions(
    rules({ allow: ["t__*"], ask: ["t__sneaky"], deny: ["t__send"] }),
    file(),
    () => true,
  );
  expect(p.decide("t__send", "read")).toEqual({ decision: "deny", reason: "deny rule" });
  expect(p.decide("t__sneaky", "read")).toEqual({ decision: "ask", reason: "ask rule" });
  expect(p.decide("t__other", "write")).toEqual({ decision: "allow", reason: "allow rule" });
});

test("dangerous tools ignore allow rules, plugin defaults and remembered choices", () => {
  const p = new Permissions(rules({ allow: ["shell__*"] }), file(), () => true);
  p.remember("shell__run", "always");
  expect(p.decide("shell__run", "dangerous").decision).toBe("ask");
  expect(p.canRemember("dangerous")).toBe(false);
  expect(p.canRemember("external")).toBe(true);
});

test("plugin defaults allow, but user rules still win", () => {
  const p = new Permissions(rules({ deny: ["memory__save"] }), file(), (t) =>
    t.startsWith("memory__"),
  );
  expect(p.decide("memory__update", "write")).toEqual({
    decision: "allow",
    reason: "plugin default",
  });
  expect(p.decide("memory__save", "write").decision).toBe("deny");
});

test("'always' is saved and survives a restart; 'session' doesn't", () => {
  const f = file();
  const first = new Permissions(rules(), f);
  expect(first.remember("t__save", "always")).toBe(true);
  expect(first.remember("t__draft", "session")).toBe(true);
  expect(first.remember("t__send", "deny")).toBe(false);
  expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ allow: ["t__save"] });

  const restarted = new Permissions(rules(), f);
  expect(restarted.decide("t__save", "write")).toEqual({
    decision: "allow",
    reason: "allowed always",
  });
  expect(restarted.decide("t__draft", "write").decision).toBe("ask");
});

test("session choices end with clearSession; an unreadable file is ignored", () => {
  const f = file();
  writeFileSync(f, "not json");
  setLogSink(() => {}); // the warning about the bad file is expected here
  const p = new Permissions(rules(), f);
  setLogSink(null);
  p.remember("t__draft", "session");
  expect(p.decide("t__draft", "write").decision).toBe("allow");
  p.clearSession();
  expect(p.decide("t__draft", "write").decision).toBe("ask");
});
