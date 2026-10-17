import { expect, test } from "bun:test";
import { parseLine } from "./format.ts";
import { compare, search, terms } from "./search.ts";

const items = (...lines: string[]) =>
  lines.map((raw) => ({
    raw,
    entry: parseLine(raw).entry as NonNullable<ReturnType<typeof parseLine>["entry"]>,
  }));
const found = (hits: Array<{ raw: string }>) => hits.map((h) => h.raw);

test("terms: words, CJK bigrams, and a boundary at every script change", () => {
  expect(terms("Dentist at 15:00")).toEqual(["dentist", "at", "15", "00"]);
  expect(terms("看牙医")).toEqual(["看牙", "牙医"]);
  expect(terms("修改youer服务端")).toEqual(["修改", "youer", "服务", "务端"]);
  expect(terms("牙")).toEqual(["牙"]);
  expect(terms("claude 队列")).toEqual(["claude", "队列"]);
});

test("finds Chinese by bigram and ranks the better match first", () => {
  const todo = "- [todo 2026-10-17 due:2026-10-21] 看牙医 15:00 #health";
  const clinic = "- [fact 2026-10-02] 牙医诊所在新宿";
  const all = items("- [fact 2026-10-01] 公司 VPN 用 WireGuard", todo, clinic);
  expect(found(search(all, "下周看牙医"))).toEqual([todo, clinic]);
});

test("tags bridge languages and count extra", () => {
  const dentist = "- [fact 2026-10-01] Dentist on Oct 21 #牙医";
  const all = items(dentist, "- [fact 2026-10-02] Mei likes sushi");
  expect(found(search(all, "牙医"))).toEqual([dentist]);
});

test("prefix matching for Latin words, single CJK characters as substrings", () => {
  const dentist = "- [fact 2026-10-01] Dentist appointment";
  const sushi = "- [fact 2026-10-02] 喜欢寿司";
  const all = items(dentist, sushi);
  expect(found(search(all, "dent"))).toEqual([dentist]);
  expect(found(search(all, "寿"))).toEqual([sushi]);
  expect(search(all, "de")).toEqual([]); // too short for a prefix
});

test("mixed queries match term by term; any term counts", () => {
  const both = "- [fact 2026-10-01] claude 的任务队列很慢";
  const one = "- [fact 2026-10-02] 队列 in redis";
  const all = items(both, one);
  expect(found(search(all, "claude 队列"))).toEqual([both, one]);
  expect(search(all, "nothing here")).toEqual([]);
});

test("ties go to the newer (later) line", () => {
  const newer = "- [fact 2026-10-02] tea";
  expect(found(search(items("- [fact 2026-10-01] tea", newer), "tea"))[0]).toBe(newer);
});

test("near-duplicates, and the veto on numbers, dates and rare words", () => {
  const common = [new Set(terms("passport renewed at the office")), new Set(terms("expires soon"))];
  expect(compare("Prefers concise answers.", "prefers concise answers", []).kind).toBe("duplicate");
  expect(compare("Passport expires 2027-12", "Passport expires 2026-12", common).kind).toBe(
    "similar",
  );
  // A differing word no other line uses (a name) vetoes; a common one doesn't.
  expect(compare("Lunch with Mei on Friday", "Lunch with Ken on Friday", []).kind).toBe("similar");
  expect(compare("Mei likes sushi", "Lunch plans", []).kind).toBe("different");
});
