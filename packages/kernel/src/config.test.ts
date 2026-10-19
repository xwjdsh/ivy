import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canSwitchModel, loadConfig, modelChoices, resolvePaths } from "./config.ts";

const tempPaths = () => resolvePaths(mkdtempSync(join(tmpdir(), "ivy-cfg-")));

function configWith(toml: string) {
  const paths = tempPaths();
  writeFileSync(paths.config, toml);
  return paths;
}

// Ends inside [providers.anthropic], so tests can append keys to it.
const MINIMAL = '[agent]\nmodel = "anthropic/claude-opus-5-5"\n\n[providers.anthropic]\n';

test("minimal config: a model on a provider; everything else defaulted", () => {
  const config = loadConfig(configWith(MINIMAL));
  expect(config.agent).toEqual({ model: "anthropic/claude-opus-5-5", max_steps: 25 });
  expect(config.model.ref).toBe("anthropic/claude-opus-5-5");
  expect(config.model.id).toBe("claude-opus-5-5");
  expect(config.model.provider).toMatchObject({
    name: "anthropic",
    type: "anthropic",
    base_url: "https://api.anthropic.com",
    models: [],
    refusal_fallback: true,
  });
  expect(config.model.provider.api_key).toBeUndefined();
  expect(config.generation).toEqual({ effort: "medium", max_tokens: 64000 });
});

test("agent.model is required", () => {
  expect(() => loadConfig(tempPaths())).toThrow(
    'agent.model: required, e.g. model = "anthropic/claude-opus-5-5" under [agent]',
  );
});

test("agent.model splits at the first slash: the provider, then the model id as is", () => {
  const config = loadConfig(
    configWith(`[agent]
model = "proxy/codex/gpt-6-luna"

[providers.anthropic]
api_key = "sk-official"

[providers.proxy]
api_key = "sk-proxy"
base_url = "https://proxy.example.com"
refusal_fallback = false

[generation]
effort = "high"
`),
  );
  expect(config.model.id).toBe("codex/gpt-6-luna");
  expect(config.model.provider).toMatchObject({
    name: "proxy",
    api_key: "sk-proxy",
    base_url: "https://proxy.example.com",
    refusal_fallback: false,
  });
  expect(Object.keys(config.providers)).toEqual(["anthropic", "proxy"]);
  expect(config.generation.effort).toBe("high");
});

test("a model on a provider that isn't configured, or without one, fails clearly", () => {
  const withModel = (model: string) =>
    configWith(`[agent]\nmodel = "${model}"\n[providers.anthropic]\n`);
  expect(() => loadConfig(withModel("openai/gpt-6"))).toThrow(
    'agent.model: "openai/gpt-6": no [providers.openai] section (configured: anthropic)',
  );
  expect(() => loadConfig(withModel("claude-opus-5-5"))).toThrow(
    '"claude-opus-5-5" should be "<provider>/<model id>"',
  );
});

test("a provider name can't contain a slash", () => {
  expect(() => loadConfig(configWith(`${MINIMAL}[providers."a/b"]\n`))).toThrow(
    "a provider name can't contain '/'",
  );
});

test("modelChoices: every provider's models, in order, plus the current one if unlisted", () => {
  const config = loadConfig(
    configWith(`[agent]
model = "a/x"
[providers.a]
models = ["y", "y", "z"]
[providers.b]
models = ["w/v"]
`),
  );
  expect(modelChoices(config)).toEqual(["a/x", "a/y", "a/z", "b/w/v"]);
  expect(modelChoices(config, "a/z")).toEqual(["a/y", "a/z", "b/w/v"]);
  // The upstream list only counts for a provider without its own `models`.
  expect(modelChoices(config, "a/z", { a: ["q"], b: ["r"] })).toEqual(["a/y", "a/z", "b/w/v"]);
});

test("a provider without `models` offers what its endpoint lists", () => {
  const config = loadConfig(
    configWith('[agent]\nmodel = "a/x"\n[providers.a]\n[providers.b]\nmodels = ["v"]\n'),
  );
  expect(modelChoices(config)).toEqual(["a/x", "b/v"]);
  expect(modelChoices(config, "a/x", { a: ["x", "y"] })).toEqual(["a/x", "a/y", "b/v"]);
  expect(canSwitchModel(config)).toBe(true);
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

test("[permissions] rules parse; default is no rules", () => {
  expect(loadConfig(configWith(MINIMAL)).permissions).toEqual({ allow: [], ask: [], deny: [] });
  const config = loadConfig(
    configWith(`${MINIMAL}[permissions]\nallow = ["memory__*"]\ndeny = ["gmail__send"]\n`),
  );
  expect(config.permissions).toEqual({ allow: ["memory__*"], ask: [], deny: ["gmail__send"] });
});

test("relative IVY_HOME resolves to an absolute path", () => {
  expect(resolvePaths(".ivy").home).toBe(join(process.cwd(), ".ivy"));
});
