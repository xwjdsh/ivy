import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { Capabilities, rejectedFeature } from "./capabilities.ts";

const OFFICIAL = "https://api.anthropic.com";
const PROXY = "http://127.0.0.1:3425";
const settings = { effort: "xhigh" as const, refusalFallback: true };
const tempFile = () => join(mkdtempSync(join(tmpdir(), "ivy-caps-")), "cache", "models.json");
const caps = (endpoint = OFFICIAL, file = tempFile()) =>
  new Capabilities(file, endpoint, endpoint === OFFICIAL, settings);

test("official API: newer Claude models get the Anthropic-only features, by default", () => {
  // A model that doesn't exist yet needs no code change.
  for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-9"]) {
    expect(caps().for(model)).toEqual({ effort: "xhigh", fallbacks: true, systemMessages: true });
  }
});

test("older models known to lack them don't get them", () => {
  for (const model of [
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-opus-4-7",
    "claude-3-5-haiku",
  ]) {
    expect(caps().for(model)).toMatchObject({ fallbacks: false, systemMessages: false });
  }
  expect(caps().for("claude-haiku-4-5").effort).toBeUndefined();
});

test("compatible endpoints get only the basics (compatibility first)", () => {
  expect(caps(PROXY).for("claude-opus-5-5")).toEqual({
    effort: "xhigh",
    fallbacks: false,
    systemMessages: false,
  });
  expect(caps(PROXY).for("qoder/qfmodel")).toMatchObject({
    fallbacks: false,
    systemMessages: false,
  });
});

test("refusal_fallback = false turns fallbacks off even on the official API", () => {
  const c = new Capabilities(tempFile(), OFFICIAL, true, {
    effort: "high",
    refusalFallback: false,
  });
  expect(c.for("claude-opus-5-5").fallbacks).toBe(false);
});

test("learned 'unsupported' features stick, per model and endpoint, across restarts", () => {
  const file = tempFile();
  const a = caps(OFFICIAL, file);
  a.markUnsupported("claude-opus-9", "systemMessages");
  expect(a.for("claude-opus-9").systemMessages).toBe(false);
  expect(a.for("claude-opus-5-5").systemMessages).toBe(true);
  expect(caps(OFFICIAL, file).for("claude-opus-9")).toMatchObject({
    systemMessages: false,
    fallbacks: true,
  });
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
  await c.refresh({
    listModels: async () => [
      info("claude-a", { low: true, medium: true, high: true }, 32000), // no xhigh → high
      info("claude-b", { supported: false }),
    ],
  });
  expect(c.for("claude-a")).toMatchObject({ effort: "high", maxTokens: 32000 });
  expect(c.for("claude-b").effort).toBeUndefined();
});

test("refresh: official only, at most once a day, failures ignored", async () => {
  let calls = 0;
  const lister = {
    listModels: async () => {
      calls++;
      return [];
    },
  };
  await caps(PROXY).refresh(lister);
  expect(calls).toBe(0);

  const file = tempFile();
  const now = Date.now();
  await caps(OFFICIAL, file).refresh(lister, now);
  await caps(OFFICIAL, file).refresh(lister, now + 60_000);
  expect(calls).toBe(1);
  await caps(OFFICIAL, file).refresh(lister, now + 25 * 60 * 60 * 1000);
  expect(calls).toBe(2);

  const failing = { listModels: () => Promise.reject(new Error("offline")) };
  await expect(caps().refresh(failing)).resolves.toBeUndefined();
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
  c.markUnsupported("claude-opus-5-5", "systemMessages");
  const lines = c.explain("claude-opus-5-5").join("\n");
  expect(lines).toContain("official Anthropic API");
  expect(lines).toContain("refusal fallback: on");
  expect(lines).toContain(
    "system messages for context: off: rejected by this endpoint earlier (learned)",
  );
  expect(caps(PROXY).explain("qoder/x").join("\n")).toContain(
    "refusal fallback: off: compatible endpoint",
  );
});
