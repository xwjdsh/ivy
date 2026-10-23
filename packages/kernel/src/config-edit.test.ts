import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths } from "./config.ts";
import {
  addProvider,
  removeApiKey,
  removeProvider,
  saveAllowRule,
  saveEffort,
  saveModel,
  updateProvider,
  withListItem,
  withoutKey,
  withoutTable,
  withRaw,
  withValue,
} from "./config-edit.ts";

const CONFIG = `# my notes
[agent]
model = "my-proxy/vendor/model-a"   # main model

[providers.anthropic]
api_key = "k"

[providers.my-proxy]
base_url = "http://127.0.0.1:8080"
models = ["vendor/model-a", "vendor/model-b"]

[generation]
effort = "medium"
`;

const tempPaths = () => resolvePaths(mkdtempSync(join(tmpdir(), "ivy-edit-")));

test("replaces only the value in the right section, keeping comments and layout", () => {
  const out = withValue(CONFIG, ["agent"], "model", "my-proxy/vendor/model-b");
  expect(out).toBe(
    CONFIG.replace(
      'model = "my-proxy/vendor/model-a"   # main',
      'model = "my-proxy/vendor/model-b"   # main',
    ),
  );
});

test("quoted section names and single-quoted values work", () => {
  const toml = `[providers."my.proxy"]\nbase_url = 'a'\n`;
  expect(withValue(toml, ["providers", "my.proxy"], "base_url", "b")).toBe(
    `[providers."my.proxy"]\nbase_url = "b"\n`,
  );
});

test("adds the key right after the header when the section lacks it", () => {
  expect(withValue("[providers.p]\napi_key = 'k'\n", ["providers", "p"], "base_url", "u")).toBe(
    "[providers.p]\nbase_url = \"u\"\napi_key = 'k'\n",
  );
});

test("an unknown section is an error", () => {
  expect(() => withValue(CONFIG, ["providers", "nope"], "base_url", "u")).toThrow(
    "No [providers.nope] section",
  );
});

test("saveModel writes [agent] model, validates and returns the new config", () => {
  const paths = tempPaths();
  writeFileSync(paths.config, CONFIG);
  const config = saveModel(paths, "anthropic/claude-opus-5-5");
  expect(config.model).toMatchObject({ id: "claude-opus-5-5", provider: { name: "anthropic" } });
  expect(readFileSync(paths.config, "utf8")).toContain(
    'model = "anthropic/claude-opus-5-5"   # main model',
  );
});

test("if the result doesn't validate, the file is restored", () => {
  const paths = tempPaths();
  writeFileSync(paths.config, CONFIG);
  expect(() => saveModel(paths, "nope/model")).toThrow("Could not save the model");
  expect(readFileSync(paths.config, "utf8")).toBe(CONFIG);
  // Checked beside it, nothing left behind, and the error names config.toml itself.
  expect(existsSync(`${paths.config}.new`)).toBe(false);
  expect(() => saveModel(paths, "nope/model")).toThrow(`Invalid ${paths.config}:`);
});

test("an edit keeps the file's permissions: it may hold keys", () => {
  const paths = tempPaths();
  writeFileSync(paths.config, CONFIG, { mode: 0o600 });
  // Even past a file a crash left behind with looser ones.
  writeFileSync(`${paths.config}.new`, "", { mode: 0o644 });
  saveEffort(paths, "high");
  expect(statSync(paths.config).mode & 0o777).toBe(0o600);
});

test("saveEffort replaces [generation] effort in place", () => {
  const paths = tempPaths();
  writeFileSync(paths.config, CONFIG);
  expect(saveEffort(paths, "high").generation.effort).toBe("high");
  expect(readFileSync(paths.config, "utf8")).toBe(
    CONFIG.replace('effort = "medium"', 'effort = "high"'),
  );
});

test("saveEffort adds a [generation] table when there is none", () => {
  const paths = tempPaths();
  const noGeneration = '[agent]\nmodel = "anthropic/claude-opus-5-5"\n[providers.anthropic]\n';
  writeFileSync(paths.config, noGeneration);
  expect(saveEffort(paths, "low").generation.effort).toBe("low");
  expect(readFileSync(paths.config, "utf8")).toBe(
    `${noGeneration}\n[generation]\neffort = "low"\n`,
  );
});

test("a dotted table name is not mistaken for a shorter one", () => {
  const toml = '[providers.a.b]\nbase_url = "x"\n[providers.a]\nbase_url = "y"\n';
  expect(withValue(toml, ["providers", "a"], "base_url", "z")).toBe(
    '[providers.a.b]\nbase_url = "x"\n[providers.a]\nbase_url = "z"\n',
  );
});

const add = (toml: string, value = "memory__delete") =>
  withListItem(toml, ["permissions"], "allow", value);

test("list items: one-line lists, empty or not, keep their comments", () => {
  expect(add("[permissions]\nallow = []  # mine\n")).toBe(
    '[permissions]\nallow = ["memory__delete"]  # mine\n',
  );
  expect(add('[permissions]\nallow = ["a__*"] # x\nask = []\n')).toBe(
    '[permissions]\nallow = ["a__*", "memory__delete"] # x\nask = []\n',
  );
  expect(add('[permissions]\nallow = ["a",]\n')).toBe(
    '[permissions]\nallow = ["a", "memory__delete"]\n',
  );
});

test("list items: multi-line lists get a new line, a comma where needed, comments kept", () => {
  const before = `[permissions]
allow = [
    "gmail__*",   # mail is fine
    "core__*"     # time
]
deny = ["shell__*"]
`;
  expect(add(before)).toBe(`[permissions]
allow = [
    "gmail__*",   # mail is fine
    "core__*",     # time
    "memory__delete",
]
deny = ["shell__*"]
`);
  // Brackets and # inside strings don't confuse it; items on the closing line are kept.
  expect(add('[permissions]\nallow = [\n  "a[1]#b",\n  "c"]\n')).toBe(
    '[permissions]\nallow = [\n  "a[1]#b",\n  "c", "memory__delete"]\n',
  );
});

test("list items: a missing key or table is added; other tables are untouched", () => {
  expect(add("[permissions]\ndeny = []\n")).toBe(
    '[permissions]\nallow = ["memory__delete"]\ndeny = []\n',
  );
  expect(add(CONFIG)).toBe(`${CONFIG}\n[permissions]\nallow = ["memory__delete"]\n`);
  expect(add("[plugins.x]\nallow = []\n[permissions]\n")).toBe(
    '[plugins.x]\nallow = []\n[permissions]\nallow = ["memory__delete"]\n',
  );
});

test("saveAllowRule writes, validates and keeps the rest of the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ivy-edit-"));
  const paths = resolvePaths(dir);
  writeFileSync(paths.config, `${CONFIG}\n[permissions]\nallow = [\n  "core__*", # time\n]\n`);
  const config = saveAllowRule(paths, "memory__delete");
  expect(config.permissions.allow).toEqual(["core__*", "memory__delete"]);
  expect(readFileSync(paths.config, "utf8")).toContain(
    '  "core__*", # time\n  "memory__delete",\n]',
  );
  expect(readFileSync(paths.config, "utf8")).toStartWith("# my notes\n");
});

const PROVIDERS = `[agent]
model = "anthropic/claude-opus-5-5"

# the official API
[providers.anthropic]
api_key = "sk-1"   # moved soon

# a local proxy
[providers.proxy]
base_url = "http://127.0.0.1:8080"
models = [
  "a",   # the fast one
  "b",
]

# how hard it thinks
[generation]
effort = "medium"
`;

test("a table goes, its lines only: the next one keeps its comment", () => {
  const out = withoutTable(PROVIDERS, ["providers", "proxy"]);
  expect(out).not.toContain("proxy");
  expect(out).not.toContain('"a"');
  expect(out).toContain('api_key = "sk-1"   # moved soon\n\n# how hard it thinks\n[generation]');
  expect(() => withoutTable(PROVIDERS, ["providers", "none"])).toThrow("No [providers.none]");
});

test("a key goes, a list over several lines included; a missing one changes nothing", () => {
  const out = withoutKey(PROVIDERS, ["providers", "proxy"], "models");
  expect(out).toContain('base_url = "http://127.0.0.1:8080"\n\n# how hard it thinks');
  expect(out).not.toContain("the fast one");
  expect(withoutKey(PROVIDERS, ["providers", "proxy"], "api_key")).toBe(PROVIDERS);
});

test("a list is replaced whole, or added after the header", () => {
  const out = withRaw(PROVIDERS, ["providers", "proxy"], "models", '["c"]');
  expect(out).toContain('base_url = "http://127.0.0.1:8080"\nmodels = ["c"]\n\n# how hard');
  const added = withRaw(PROVIDERS, ["providers", "anthropic"], "models", '["m"]');
  expect(added).toContain('[providers.anthropic]\nmodels = ["m"]\napi_key');
});

test("providers are added, changed and removed in place, the rest of the file untouched", () => {
  const paths = tempPaths();
  writeFileSync(paths.config, PROVIDERS);
  const added = addProvider(paths, "kimi", { type: "anthropic", base_url: "https://k.example/v1" });
  expect(added.providers.kimi?.base_url).toBe("https://k.example/v1");
  expect(readFileSync(paths.config, "utf8")).toStartWith(PROVIDERS);
  expect(readFileSync(paths.config, "utf8")).toEndWith(
    '\n[providers.kimi]\ntype = "anthropic"\nbase_url = "https://k.example/v1"\n',
  );
  expect(() => addProvider(paths, "kimi", { type: "anthropic" })).toThrow("named kimi already");
  expect(() => addProvider(paths, "a/b", { type: "anthropic" })).toThrow("letters, digits");

  const changed = updateProvider(paths, "proxy", { base_url: "http://127.0.0.1:9090", models: [] });
  expect(changed.providers.proxy?.base_url).toBe("http://127.0.0.1:9090");
  expect(changed.providers.proxy?.models).toEqual([]);
  expect(readFileSync(paths.config, "utf8")).toContain("# a local proxy\n[providers.proxy]");

  expect(removeApiKey(paths, "anthropic").providers.anthropic?.api_key).toBeUndefined();
  expect(readFileSync(paths.config, "utf8")).toContain(
    "# the official API\n[providers.anthropic]\n",
  );

  const removed = removeProvider(paths, "kimi");
  expect(removed.providers.kimi).toBeUndefined();
  expect(readFileSync(paths.config, "utf8")).toEndWith('effort = "medium"\n');
});

test("removing the provider of the model in use is refused, the file left as it was", () => {
  const paths = tempPaths();
  writeFileSync(paths.config, PROVIDERS);
  expect(() => removeProvider(paths, "anthropic")).toThrow("Could not save the provider");
  expect(readFileSync(paths.config, "utf8")).toBe(PROVIDERS);
});
