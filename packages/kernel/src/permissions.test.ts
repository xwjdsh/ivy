import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  expect(p.decide("t__send", "read")).toMatchObject({ decision: "deny", reason: "deny rule" });
  expect(p.decide("t__sneaky", "read")).toMatchObject({ decision: "ask", reason: "ask rule" });
  expect(p.decide("t__other", "write")).toMatchObject({ decision: "allow", reason: "allow rule" });
});

test("only risk-default asks can be remembered", () => {
  const p = new Permissions(rules({ ask: ["t__sneaky"] }), file());
  expect(p.decide("t__x", "write")).toEqual({
    decision: "ask",
    reason: "write tool",
    canRemember: true,
  });
  expect(p.decide("t__x", "dangerous").canRemember).toBe(false);
  expect(p.decide("t__sneaky", "read").canRemember).toBe(false);
});

test("'always' is ignored where it would have no effect, whatever the interface sent", () => {
  const f = file();
  const p = new Permissions(rules({ allow: ["shell__*"], ask: ["t__sneaky"] }), f, () => true);
  for (const [tool, risk] of [
    ["shell__run", "dangerous"],
    ["t__sneaky", "read"],
  ] as const) {
    const asked = p.decide(tool, risk);
    expect(p.remember(tool, "always", asked)).toBe(true); // runs this once
    expect(p.remember(tool, "session", asked)).toBe(true);
    expect(p.decide(tool, risk).decision).toBe("ask"); // still asked next time
  }
  expect(existsSync(f)).toBe(false); // nothing was saved
});

test("plugin defaults allow, but user rules still win", () => {
  const p = new Permissions(rules({ deny: ["memory__save"] }), file(), (t) =>
    t.startsWith("memory__"),
  );
  expect(p.decide("memory__update", "write")).toMatchObject({
    decision: "allow",
    reason: "plugin default",
  });
  expect(p.decide("memory__save", "write").decision).toBe("deny");
});

test("'always' is saved and survives a restart; 'session' doesn't", () => {
  const f = file();
  const first = new Permissions(rules(), f);
  const ask = first.decide("t__any", "write");
  expect(first.remember("t__save", "always", ask)).toBe(true);
  expect(first.remember("t__draft", "session", ask)).toBe(true);
  expect(first.remember("t__send", "deny", ask)).toBe(false);
  expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ allow: ["t__save"] });

  const restarted = new Permissions(rules(), f);
  expect(restarted.decide("t__save", "write")).toMatchObject({
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
  p.remember("t__draft", "session", p.decide("t__draft", "write"));
  expect(p.decide("t__draft", "write").decision).toBe("allow");
  p.clearSession();
  expect(p.decide("t__draft", "write").decision).toBe("ask");
});

test("saving keeps rules another Ivy process saved meanwhile", () => {
  const f = file();
  const a = new Permissions(rules(), f);
  const b = new Permissions(rules(), f);
  a.remember("t__one", "always", a.decide("t__one", "write"));
  b.remember("t__two", "always", b.decide("t__two", "write"));
  expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ allow: ["t__one", "t__two"] });
});
