import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolvePaths } from "./config.ts";

test("defaults apply without a config file", () => {
  const config = loadConfig(resolvePaths(mkdtempSync(join(tmpdir(), "ivy-cfg-"))));
  expect(config.model).toMatchObject({ name: "claude-opus-5-5", effort: "medium" });
  expect(config.model.api_key).toBeUndefined();
});

test("api_key and overrides are read from config.toml", () => {
  const paths = resolvePaths(mkdtempSync(join(tmpdir(), "ivy-cfg-")));
  writeFileSync(paths.config, '[model]\napi_key = "sk-test"\neffort = "high"\n');
  expect(loadConfig(paths).model).toMatchObject({ api_key: "sk-test", effort: "high" });
});

test("base_url must be a URL", () => {
  const paths = resolvePaths(mkdtempSync(join(tmpdir(), "ivy-cfg-")));
  writeFileSync(paths.config, '[model]\nbase_url = "https://proxy.example.com"\n');
  expect(loadConfig(paths).model.base_url).toBe("https://proxy.example.com");
  writeFileSync(paths.config, '[model]\nbase_url = "not a url"\n');
  expect(() => loadConfig(paths)).toThrow("Invalid");
});

test("invalid values fail with a readable error", () => {
  const paths = resolvePaths(mkdtempSync(join(tmpdir(), "ivy-cfg-")));
  writeFileSync(paths.config, '[model]\neffort = "turbo"\n');
  expect(() => loadConfig(paths)).toThrow("Invalid");
});

test("relative IVY_HOME resolves to an absolute path", () => {
  expect(resolvePaths(".ivy").home).toBe(join(process.cwd(), ".ivy"));
});
