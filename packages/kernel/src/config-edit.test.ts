import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths } from "./config.ts";
import {
  saveAllowRule,
  saveDefaultModel,
  saveEffort,
  withListItem,
  withValue,
} from "./config-edit.ts";

const CONFIG = `# my notes
[agent]
provider = "my-proxy"

[providers.anthropic]
default_model = "claude-opus-5-5"

[providers.my-proxy]
base_url = "http://127.0.0.1:8080"
default_model = "vendor/model-a"   # required; used at startup
models = ["vendor/model-a", "vendor/model-b"]

[generation]
effort = "medium"
`;

test("replaces only the value in the right section, keeping comments and layout", () => {
  const out = withValue(CONFIG, ["providers", "my-proxy"], "default_model", "vendor/model-b");
  expect(out).toBe(
    CONFIG.replace(
      'default_model = "vendor/model-a"   # required',
      'default_model = "vendor/model-b"   # required',
    ),
  );
  expect(out).toContain('[providers.anthropic]\ndefault_model = "claude-opus-5-5"');
});

test("quoted section names and single-quoted values work", () => {
  const toml = `[providers."my.proxy"]\ndefault_model = 'a'\n`;
  expect(withValue(toml, ["providers", "my.proxy"], "default_model", "b")).toBe(
    `[providers."my.proxy"]\ndefault_model = "b"\n`,
  );
});

test("adds default_model right after the header when the section lacks it", () => {
  expect(
    withValue("[providers.p]\napi_key = 'k'\n", ["providers", "p"], "default_model", "m"),
  ).toBe("[providers.p]\ndefault_model = \"m\"\napi_key = 'k'\n");
});

test("an unknown provider is an error", () => {
  expect(() => withValue(CONFIG, ["providers", "nope"], "default_model", "m")).toThrow(
    "No [providers.nope] section",
  );
});

test("saveDefaultModel writes, validates and returns the new config", () => {
  const paths = resolvePaths(mkdtempSync(join(tmpdir(), "ivy-edit-")));
  writeFileSync(paths.config, CONFIG);
  const config = saveDefaultModel(paths, "my-proxy", "vendor/model-b");
  expect(config.activeProvider.default_model).toBe("vendor/model-b");
  expect(readFileSync(paths.config, "utf8")).toContain("# my notes");
});

test("if the result doesn't validate, the file is restored", () => {
  const paths = resolvePaths(mkdtempSync(join(tmpdir(), "ivy-edit-")));
  const broken = `${CONFIG}\n[generation]\nefort = "x"\n`; // already invalid
  writeFileSync(paths.config, broken);
  expect(() => saveDefaultModel(paths, "my-proxy", "vendor/model-b")).toThrow(
    "Could not save default_model",
  );
  expect(readFileSync(paths.config, "utf8")).toBe(broken);
});

test("saveEffort replaces [generation] effort in place", () => {
  const paths = resolvePaths(mkdtempSync(join(tmpdir(), "ivy-edit-")));
  writeFileSync(paths.config, CONFIG);
  expect(saveEffort(paths, "high").generation.effort).toBe("high");
  expect(readFileSync(paths.config, "utf8")).toBe(
    CONFIG.replace('effort = "medium"', 'effort = "high"'),
  );
});

test("saveEffort adds a [generation] table when there is none", () => {
  const paths = resolvePaths(mkdtempSync(join(tmpdir(), "ivy-edit-")));
  const noGeneration = '[providers.anthropic]\ndefault_model = "claude-opus-5-5"\n';
  writeFileSync(paths.config, noGeneration);
  expect(saveEffort(paths, "low").generation.effort).toBe("low");
  expect(readFileSync(paths.config, "utf8")).toBe(
    `${noGeneration}\n[generation]\neffort = "low"\n`,
  );
});

test("a dotted table name is not mistaken for a shorter one", () => {
  const toml = '[providers.a.b]\ndefault_model = "x"\n[providers.a]\ndefault_model = "y"\n';
  expect(withValue(toml, ["providers", "a"], "default_model", "z")).toBe(
    '[providers.a.b]\ndefault_model = "x"\n[providers.a]\ndefault_model = "z"\n',
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
