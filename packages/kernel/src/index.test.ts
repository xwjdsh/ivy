import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { addProvider, createIvy, MemoryKeyStore, resolvePaths, whyUnreachable } from "./index.ts";

test("a missing API key doesn't stop Ivy (the settings set it); a turn names the provider", async () => {
  const paths = resolvePaths(mkdtempSync(join(tmpdir(), "ivy-key-")));
  writeFileSync(paths.config, '[agent]\nmodel = "proxy/m"\n[providers.proxy]\n');
  const ivy = await createIvy({ plugins: [], paths, keys: new MemoryKeyStore() });
  expect(ivy.keySource("proxy")).toBe("none");
  expect(() => ivy.agent.setModel("proxy/m")).toThrow("No API key for proxy");
});

// A local endpoint, so the background model-list refresh never reaches the network.
const LOCAL = 'base_url = "http://127.0.0.1:9"';

test("a key in the key store serves a provider without api_key", async () => {
  const paths = resolvePaths(mkdtempSync(join(tmpdir(), "ivy-key-")));
  writeFileSync(paths.config, `[agent]\nmodel = "proxy/m"\n[providers.proxy]\n${LOCAL}\n`);
  const keys = new MemoryKeyStore();
  keys.set("proxy", "sk-from-store");
  const ivy = await createIvy({ plugins: [], paths, keys });
  expect(ivy.keySource("proxy")).toBe("keychain");
});

test("providers added to config.toml are used after a reload", async () => {
  const paths = resolvePaths(mkdtempSync(join(tmpdir(), "ivy-key-")));
  writeFileSync(
    paths.config,
    `[agent]\nmodel = "proxy/m"\n[providers.proxy]\napi_key = "k"\n${LOCAL}\n`,
  );
  const ivy = await createIvy({ plugins: [], paths, keys: new MemoryKeyStore() });
  addProvider(paths, "other", { type: "anthropic", base_url: "http://127.0.0.1:9" });
  expect(ivy.config.providers.other).toBeUndefined();
  ivy.reloadProviders();
  expect(ivy.config.providers.other?.base_url).toBe("http://127.0.0.1:9");
  expect(ivy.keySource("proxy")).toBe("config");
  expect(ivy.keySource("other")).toBe("none");
  expect(ivy.agent.model).toBe("proxy/m");
});

test("a failed connection test reads as a sentence, not the API's error body", () => {
  const body = (message: string) => ({ type: "error", error: { type: "x", message } });
  const fromApi = (status: number, message: string) =>
    Anthropic.APIError.generate(status, body(message), undefined, new Headers());
  expect(whyUnreachable(fromApi(401, "invalid x-api-key"))).toBe(
    "the endpoint refused the key (401)",
  );
  expect(whyUnreachable(fromApi(404, "no such route"))).toBe(
    "the endpoint answered 404: no such route",
  );
  expect(whyUnreachable(new Anthropic.APIConnectionError({ message: "Connection error." }))).toBe(
    "couldn't reach the endpoint (Connection error.)",
  );
});
