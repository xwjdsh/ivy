import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths } from "./config.ts";
import { saveDefaultModel, saveEffort, withValue } from "./config-edit.ts";

const CONFIG = `# my notes
[agent]
provider = "magpie"

[providers.anthropic]
default_model = "claude-opus-5-5"

[providers.magpie]
base_url = "http://127.0.0.1:3425"
default_model = "qoder/qfmodel"   # required; used at startup
models = ["qoder/qfmodel", "qoder/dfmodel"]

[generation]
effort = "medium"
`;

test("replaces only the value in the right section, keeping comments and layout", () => {
  const out = withValue(CONFIG, ["providers", "magpie"], "default_model", "qoder/dfmodel");
  expect(out).toBe(
    CONFIG.replace(
      'default_model = "qoder/qfmodel"   # required',
      'default_model = "qoder/dfmodel"   # required',
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
  const config = saveDefaultModel(paths, "magpie", "qoder/dfmodel");
  expect(config.activeProvider.default_model).toBe("qoder/dfmodel");
  expect(readFileSync(paths.config, "utf8")).toContain("# my notes");
});

test("if the result doesn't validate, the file is restored", () => {
  const paths = resolvePaths(mkdtempSync(join(tmpdir(), "ivy-edit-")));
  const broken = `${CONFIG}\n[generation]\nefort = "x"\n`; // already invalid
  writeFileSync(paths.config, broken);
  expect(() => saveDefaultModel(paths, "magpie", "qoder/dfmodel")).toThrow(
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
