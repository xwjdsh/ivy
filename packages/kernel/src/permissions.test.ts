import { expect, test } from "bun:test";
import { setLogSink } from "./log.ts";
import { matchesAny, Permissions } from "./permissions.ts";

/** A saver that records what *Always* would write to config.toml. */
const saver = () => {
  const saved: string[] = [];
  return { saved, save: (tool: string) => void saved.push(tool) };
};
const noSave = () => {};
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
  const p = new Permissions(rules(), noSave);
  expect(p.decide("t__r", "read").decision).toBe("allow");
  for (const risk of ["write", "external", "dangerous"] as const) {
    expect(p.decide("t__x", risk).decision).toBe("ask");
  }
});

test("deny beats every allow; ask beats allow and a read label", () => {
  const p = new Permissions(
    rules({ allow: ["t__*"], ask: ["t__sneaky"], deny: ["t__send"] }),
    noSave,
    () => true,
  );
  expect(p.decide("t__send", "read")).toMatchObject({ decision: "deny", reason: "deny rule" });
  expect(p.decide("t__sneaky", "read")).toMatchObject({ decision: "ask", reason: "ask rule" });
  expect(p.decide("t__other", "write")).toMatchObject({ decision: "allow", reason: "allow rule" });
});

test("only risk-default asks can be remembered", () => {
  const p = new Permissions(rules({ ask: ["t__sneaky"] }), noSave);
  expect(p.decide("t__x", "write")).toEqual({
    decision: "ask",
    reason: "write tool",
    canRemember: true,
  });
  expect(p.decide("t__x", "dangerous").canRemember).toBe(false);
  expect(p.decide("t__sneaky", "read").canRemember).toBe(false);
});

test("'always' is ignored where it would have no effect, whatever the interface sent", () => {
  const s = saver();
  const p = new Permissions(rules({ allow: ["shell__*"], ask: ["t__sneaky"] }), s.save, () => true);
  for (const [tool, risk] of [
    ["shell__run", "dangerous"],
    ["t__sneaky", "read"],
  ] as const) {
    const asked = p.decide(tool, risk);
    expect(p.remember(tool, "always", asked)).toBe(true); // runs this once
    expect(p.remember(tool, "session", asked)).toBe(true);
    expect(p.decide(tool, risk).decision).toBe("ask"); // still asked next time
  }
  expect(s.saved).toEqual([]); // nothing was saved
});

test("plugin defaults allow, but user rules still win", () => {
  const p = new Permissions(rules({ deny: ["memory__save"] }), noSave, (t) =>
    t.startsWith("memory__"),
  );
  expect(p.decide("memory__update", "write")).toMatchObject({
    decision: "allow",
    reason: "plugin default",
  });
  expect(p.decide("memory__save", "write").decision).toBe("deny");
});

test("'always' adds an allow rule (saved to config.toml); 'session' doesn't", () => {
  const s = saver();
  const p = new Permissions(rules(), s.save);
  const ask = p.decide("t__any", "write");
  expect(p.remember("t__save", "always", ask)).toBe(true);
  expect(p.remember("t__draft", "session", ask)).toBe(true);
  expect(p.remember("t__send", "deny", ask)).toBe(false);
  expect(s.saved).toEqual(["t__save"]);
  expect(p.decide("t__save", "write")).toMatchObject({ decision: "allow", reason: "allow rule" });
  expect(p.summary().allow).toEqual(["t__save"]);
  // Already covered by a rule: nothing more is saved.
  p.remember("t__save", "always", ask);
  expect(s.saved).toEqual(["t__save"]);
});

test("a failed save still allows the tool for this run", () => {
  const p = new Permissions(rules(), () => {
    throw new Error("config.toml is read-only");
  });
  setLogSink(() => {}); // the warning is expected here
  expect(p.remember("t__save", "always", p.decide("t__save", "write"))).toBe(true);
  setLogSink(null);
  expect(p.decide("t__save", "write").decision).toBe("allow");
});

test("session choices end with clearSession", () => {
  const p = new Permissions(rules(), noSave);
  p.remember("t__draft", "session", p.decide("t__draft", "write"));
  expect(p.decide("t__draft", "write").decision).toBe("allow");
  p.clearSession();
  expect(p.decide("t__draft", "write").decision).toBe("ask");
});
