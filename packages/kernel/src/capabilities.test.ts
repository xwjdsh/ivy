import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { Capabilities, rejectedFeature } from "./capabilities.ts";

const OFFICIAL = "https://api.anthropic.com";
const PROXY = "http://127.0.0.1:8080";
const tempFile = () => join(mkdtempSync(join(tmpdir(), "ivy-caps-")), "cache", "models.json");
const caps = (file = tempFile()) => new Capabilities(file, "xhigh");
const official = { base_url: OFFICIAL, refusal_fallback: true };
const proxy = { base_url: PROXY, refusal_fallback: true };
/** A model on the official API, or on another endpoint. */
const on = (id: string, provider = official) => ({ provider, id });

test("official API: newer Claude models get the Anthropic-only features, by default", () => {
  // A model that doesn't exist yet needs no code change.
  for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-9"]) {
    expect(caps().for(on(model))).toEqual({
      effort: "xhigh",
      fallbacks: true,
      systemMessages: true,
    });
  }
});

test("older models known to lack them don't get them", () => {
  for (const model of [
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-opus-4-7",
    "claude-3-5-haiku",
  ]) {
    expect(caps().for(on(model))).toMatchObject({ fallbacks: false, systemMessages: false });
  }
  expect(caps().for(on("claude-haiku-4-5")).effort).toBeUndefined();
});

test("compatible endpoints get only the basics (compatibility first)", () => {
  expect(caps().for(on("claude-opus-5-5", proxy))).toEqual({
    effort: "xhigh",
    fallbacks: false,
    systemMessages: false,
  });
  expect(caps().for(on("vendor/model-a", proxy))).toMatchObject({
    fallbacks: false,
    systemMessages: false,
  });
});

test("refusal_fallback = false turns fallbacks off even on the official API", () => {
  const c = new Capabilities(tempFile(), "high");
  expect(c.for(on("claude-opus-5-5", { ...official, refusal_fallback: false })).fallbacks).toBe(
    false,
  );
});

test("learned 'unsupported' features stick, per model and endpoint, across restarts", () => {
  const file = tempFile();
  const a = caps(file);
  a.markUnsupported(on("claude-opus-9"), "systemMessages");
  expect(a.for(on("claude-opus-9")).systemMessages).toBe(false);
  expect(a.for(on("claude-opus-5-5")).systemMessages).toBe(true);
  expect(caps(file).for(on("claude-opus-9"))).toMatchObject({
    systemMessages: false,
    fallbacks: true,
  });
});

test("endpoints are kept apart in one cache file", () => {
  const file = tempFile();
  const c = caps(file);
  c.markUnsupported(on("m", proxy), "effort");
  c.markUnsupported(on("m"), "fallbacks");
  const again = caps(file);
  expect(again.for(on("m", proxy)).effort).toBeUndefined();
  expect(again.for(on("m")).effort).toBe("xhigh");
  expect(again.explain(on("m")).join("\n")).toContain("rejected by this endpoint earlier");
});

function info(id: string, effort: Partial<Record<string, boolean>> | null, maxTokens = 128000) {
  const level = (supported = false) => ({ supported });
  return {
    id,
    max_tokens: maxTokens,
    capabilities: effort && {
      effort: {
        supported: effort.supported ?? true,
        low: level(effort.low),
        medium: level(effort.medium),
        high: level(effort.high),
        xhigh: level(effort.xhigh),
        max: level(effort.max),
      },
    },
  } as unknown as Anthropic.Models.ModelInfo;
}

test("Models API facts: effort support, nearest supported level, max_tokens", async () => {
  const c = caps();
  await c.refresh(official, {
    listModels: async () => [
      info("claude-a", { low: true, medium: true, high: true }, 32000), // no xhigh → high
      info("claude-b", { supported: false }),
    ],
  });
  expect(c.for(on("claude-a"))).toMatchObject({ effort: "high", maxTokens: 32000 });
  expect(c.for(on("claude-b")).effort).toBeUndefined();
});

test("refresh: official only, at most once a day, failures ignored", async () => {
  let calls = 0;
  const lister = {
    listModels: async () => {
      calls++;
      return [];
    },
  };
  await caps().refresh(proxy, lister);
  expect(calls).toBe(0);

  const file = tempFile();
  const now = Date.now();
  await caps(file).refresh(official, lister, now);
  await caps(file).refresh(official, lister, now + 60_000);
  expect(calls).toBe(1);
  await caps(file).refresh(official, lister, now + 25 * 60 * 60 * 1000);
  expect(calls).toBe(2);

  const failing = { listModels: () => Promise.reject(new Error("offline")) };
  await expect(caps().refresh(official, failing)).resolves.toBeUndefined();
});

test("rejectedFeature recognises the errors we can recover from", () => {
  expect(rejectedFeature("400 role 'system' is not supported on this model")).toBe(
    "systemMessages",
  );
  expect(rejectedFeature("unexpected field: clear_at")).toBe("systemMessages");
  expect(rejectedFeature("fallbacks: Extra inputs are not permitted")).toBe("fallbacks");
  expect(rejectedFeature("output_config.effort: invalid")).toBe("effort");
  expect(rejectedFeature("messages: text content blocks must be non-empty")).toBeNull();
});

test("explain says why each feature is on or off", () => {
  const c = caps();
  c.markUnsupported(on("claude-opus-5-5"), "systemMessages");
  const lines = c.explain(on("claude-opus-5-5")).join("\n");
  expect(lines).toContain("official Anthropic API");
  expect(lines).toContain("refusal fallback: on");
  expect(lines).toContain(
    "system messages for context: off: rejected by this endpoint earlier (learned)",
  );
  expect(caps().explain(on("vendor/x", proxy)).join("\n")).toContain(
    "refusal fallback: off: compatible endpoint",
  );
});

test("a broken cache file (null, an array) is ignored, not fatal", () => {
  for (const content of ["null", "[]", "42"]) {
    const file = tempFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    const c = caps(file);
    expect(c.for(on("claude-opus-5-5")).fallbacks).toBe(true);
    c.markUnsupported(on("claude-opus-5-5"), "fallbacks");
    expect(c.for(on("claude-opus-5-5")).fallbacks).toBe(false);
  }
});
