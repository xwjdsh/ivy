import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { Capabilities, rejectedFeature } from "./capabilities.ts";

const OFFICIAL = "https://api.anthropic.com";
const PROXY = "http://127.0.0.1:8080";
const tempFile = () => join(mkdtempSync(join(tmpdir(), "ivy-caps-")), "cache", "models.json");
const caps = (file = tempFile()) => new Capabilities(file, "xhigh");
const official: { base_url: string; refusal_fallback: boolean; type?: string } = {
  base_url: OFFICIAL,
  refusal_fallback: true,
};
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
      streamUsage: true,
      cacheKey: true,
      images: true,
      // Dynamic filtering where the model is known to have it; the basic search elsewhere.
      webSearch: model === "claude-opus-9" ? "web_search_20250305" : "web_search_20260209",
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

test("compatible endpoints get what they may ignore or refuse, not what is Anthropic's alone", () => {
  expect(caps().for(on("claude-opus-5-5", proxy))).toEqual({
    effort: "xhigh",
    fallbacks: false,
    systemMessages: false,
    streamUsage: true,
    cacheKey: true,
    images: true,
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
  expect(lines).toContain("(Messages API, the vendor's own)");
  expect(lines).toContain("refusal fallback: on");
  expect(lines).toContain(
    "system messages for context: off: rejected by this endpoint earlier (learned)",
  );
  expect(caps().explain(on("vendor/x", proxy)).join("\n")).toContain(
    "refusal fallback: off: compatible endpoint",
  );
});

test("Chat Completions: effort at most high, and its own features explained", () => {
  const openai = { type: "openai", base_url: "https://api.openai.com/v1", refusal_fallback: true };
  const c = new Capabilities(tempFile(), "max");
  expect(c.for(on("gpt-6", openai)).effort).toBe("high");
  expect(new Capabilities(tempFile(), "low").for(on("gpt-6", openai)).effort).toBe("low");
  const lines = c.explain(on("gpt-6", openai)).join("\n");
  expect(lines).toContain("(Chat Completions, the vendor's own)");
  expect(lines).toContain("Chat Completions takes up to high");
  expect(lines).toContain("prompt cache key: on");
  expect(lines).not.toContain("refusal fallback");
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

/** A client whose replies (or failures), in turn, answer the probe. */
function probeClient(...replies: Array<(() => never) | Array<{ type: string }>>) {
  const requests: Array<{ tools: Array<{ type: string }> }> = [];
  return {
    requests,
    async stream(request: unknown) {
      requests.push(request as (typeof requests)[number]);
      const reply = replies.shift() ?? [];
      if (typeof reply === "function") reply();
      return { content: reply } as unknown as Anthropic.Beta.BetaMessage;
    },
  };
}

const refused = (status: number) => () => {
  throw Anthropic.APIError.generate(status, { error: { message: "no" } }, "no", new Headers());
};

test("web search: on the official API by model, probed once elsewhere, never on Chat Completions", async () => {
  const file = tempFile();
  const c = caps(file);
  expect(c.for(on("claude-haiku-5-5")).webSearch).toBe("web_search_20250305");
  expect(c.for(on("gpt-6", { ...official, type: "openai" })).webSearch).toBeUndefined();
  expect(c.needsSearchProbe(on("claude-opus-5-5"))).toBe(false);

  // A proxy: nothing until probed, then what the probe saw, kept across restarts.
  const model = on("claude/claude-opus-5-5", proxy);
  expect(c.needsSearchProbe(model)).toBe(true);
  expect(c.for(model).webSearch).toBeUndefined();
  const client = probeClient([{ type: "server_tool_use" }, { type: "web_search_tool_result" }]);
  await c.probeWebSearch(model, client);
  expect(client.requests[0]).toMatchObject({ tools: [{ type: "web_search_20260209" }] });
  expect(caps(file).for(model).webSearch).toBe("web_search_20260209");
  expect(caps(file).needsSearchProbe(model)).toBe(false);

  // Answered without a search: off, and not asked again.
  const quiet = on("other/model", proxy);
  await c.probeWebSearch(quiet, probeClient([{ type: "text" }]));
  expect(c.for(quiet).webSearch).toBeUndefined();
  expect(c.needsSearchProbe(quiet)).toBe(false);

  // Unreachable: nothing kept, so a later turn tries again.
  const away = on("away/model", proxy);
  await c.probeWebSearch(
    away,
    probeClient(() => {
      throw new Error("connection refused");
    }),
  );
  expect(c.needsSearchProbe(away)).toBe(true);
});

test("a refused web search tool is learned off", () => {
  expect(rejectedFeature("tools.0: web_search_20260209 is not supported")).toBe("webSearch");
  const c = caps();
  c.markUnsupported(on("claude-opus-5-5"), "webSearch");
  expect(c.for(on("claude-opus-5-5")).webSearch).toBeUndefined();
});

test("the probe: the basic search where the filtering one is refused; other refusals retried a day later", async () => {
  const c = caps();
  const basic = on("claude/claude-opus-5-5", proxy);
  const client = probeClient(refused(400), [{ type: "web_search_tool_result" }]);
  await c.probeWebSearch(basic, client);
  expect(client.requests.map((r) => r.tools[0]?.type)).toEqual([
    "web_search_20260209",
    "web_search_20250305",
  ]);
  expect(c.for(basic).webSearch).toBe("web_search_20250305");
  // Refused later in a real turn, it is off and not probed again.
  c.markUnsupported(basic, "webSearch");
  expect(c.needsSearchProbe(basic, Date.now() + 25 * 60 * 60 * 1000)).toBe(false);

  // Busy or failing for now: nothing kept, the next turn tries again.
  const busy = on("busy/model", proxy);
  await c.probeWebSearch(busy, probeClient(refused(429)));
  await c.probeWebSearch(on("down/model", proxy), probeClient(refused(503)));
  expect(c.needsSearchProbe(busy)).toBe(true);
  expect(c.needsSearchProbe(on("down/model", proxy))).toBe(true);

  // An endpoint that answers an unknown tool with another error isn't probed every turn.
  const other = on("vendor/model", proxy);
  await c.probeWebSearch(other, probeClient(refused(422)));
  expect(c.needsSearchProbe(other)).toBe(false);
  expect(c.needsSearchProbe(other, Date.now() + 25 * 60 * 60 * 1000)).toBe(true);

  // Two turns at once probe once.
  const twice = on("twice/model", proxy);
  const both = probeClient([{ type: "web_search_tool_result" }]);
  await Promise.all([c.probeWebSearch(twice, both), c.probeWebSearch(twice, both)]);
  expect(both.requests).toHaveLength(1);
});

test("a search block the endpoint didn't like in the history isn't the tool refused", () => {
  expect(
    rejectedFeature("messages.3.content.1: web_search_tool_result: invalid encrypted_content"),
  ).toBeNull();
});

test("a cache saved under another spelling of an endpoint's URL is still found", () => {
  const file = tempFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ [`${PROXY}/`]: { models: {}, unsupported: { "vendor/m": ["effort"] } } }),
  );
  expect(caps(file).for(on("vendor/m", proxy)).effort).toBeUndefined();
});
