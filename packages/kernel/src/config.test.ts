import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolvePaths } from "./config.ts";

const tempPaths = () => resolvePaths(mkdtempSync(join(tmpdir(), "ivy-cfg-")));

function configWith(toml: string) {
  const paths = tempPaths();
  writeFileSync(paths.config, toml);
  return paths;
}

const MINIMAL = '[providers.anthropic]\ndefault_model = "claude-opus-5-5"\n';

test("minimal config: one provider with a default model; everything else defaulted", () => {
  const config = loadConfig(configWith(MINIMAL));
  expect(config.agent).toEqual({ provider: "anthropic", max_steps: 25 });
  expect(config.activeProvider).toMatchObject({
    name: "anthropic",
    type: "anthropic",
    base_url: "https://api.anthropic.com",
    default_model: "claude-opus-5-5",
    models: ["claude-opus-5-5"],
    refusal_fallback: true,
  });
  expect(config.activeProvider.api_key).toBeUndefined();
  expect(config.generation).toEqual({ effort: "medium", max_tokens: 64000 });
});

test("no provider configured fails clearly", () => {
  expect(() => loadConfig(tempPaths())).toThrow(
    'agent.provider "anthropic" has no [providers.anthropic] section (configured: none)',
  );
});

test("default_model is required", () => {
  expect(() => loadConfig(configWith('[providers.anthropic]\napi_key = "k"\n'))).toThrow(
    /default_model/,
  );
});

test("models: default_model comes first, duplicates are dropped", () => {
  const config = loadConfig(
    configWith('[providers.anthropic]\ndefault_model = "b"\nmodels = ["a", "b", "c", "a"]\n'),
  );
  expect(config.activeProvider.models).toEqual(["b", "a", "c"]);
});

test("agent.provider picks among several providers", () => {
  const config = loadConfig(
    configWith(`[agent]
provider = "proxy"

[providers.anthropic]
api_key = "sk-official"
default_model = "claude-opus-5-5"

[providers.proxy]
api_key = "sk-proxy"
base_url = "https://proxy.example.com"
default_model = "claude-sonnet-5-5"
refusal_fallback = false

[generation]
effort = "high"
`),
  );
  expect(config.activeProvider).toMatchObject({
    name: "proxy",
    api_key: "sk-proxy",
    base_url: "https://proxy.example.com",
    default_model: "claude-sonnet-5-5",
    refusal_fallback: false,
  });
  expect(Object.keys(config.providers)).toEqual(["anthropic", "proxy"]);
  expect(config.generation.effort).toBe("high");
});

test("selecting a provider that isn't configured fails clearly", () => {
  expect(() => loadConfig(configWith(`${MINIMAL}[agent]\nprovider = "openai"\n`))).toThrow(
    'agent.provider "openai" has no [providers.openai] section (configured: anthropic)',
  );
});

test("only supported provider types are accepted", () => {
  expect(() => loadConfig(configWith(`${MINIMAL}type = "openai"\n`))).toThrow(
    'unsupported provider type "openai"; supported: "anthropic"',
  );
});

test("unknown or old keys are rejected instead of ignored", () => {
  expect(() => loadConfig(configWith('[model]\napi_key = "sk-old"\n'))).toThrow(
    /Unrecognized key.*model/s,
  );
  expect(() => loadConfig(configWith(`${MINIMAL}[generation]\nefort = "high"\n`))).toThrow(
    /Unrecognized key.*efort/s,
  );
});

test("invalid values fail with a readable error", () => {
  expect(() => loadConfig(configWith(`${MINIMAL}base_url = "not a url"\n`))).toThrow("Invalid");
});

test("relative IVY_HOME resolves to an absolute path", () => {
  expect(resolvePaths(".ivy").home).toBe(join(process.cwd(), ".ivy"));
});
