import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths } from "./config.ts";
import { saveAllowRule, saveEffort, saveModel, withListItem, withValue } from "./config-edit.ts";

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
