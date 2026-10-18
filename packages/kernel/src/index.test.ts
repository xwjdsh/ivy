import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIvy, type ModelClient, resolvePaths, setLogSink } from "./index.ts";

test("old permissions.json rules move into config.toml once, and the file goes", async () => {
  const home = mkdtempSync(join(tmpdir(), "ivy-migrate-"));
  const paths = resolvePaths(home);
  writeFileSync(
    paths.config,
    '[providers.anthropic]\napi_key = "k"\ndefault_model = "claude-opus-5-5"\n\n[permissions]\nallow = ["core__*"] # mine\n',
  );
  writeFileSync(paths.legacyPermissions, JSON.stringify({ allow: ["memory__delete", "core__*"] }));
  const logs: string[] = [];
  setLogSink((line) => logs.push(line));
  const ivy = await createIvy({
    plugins: [],
    paths,
    model: {} as ModelClient,
    confirm: async () => "deny",
  });
  setLogSink(null);
  expect(existsSync(paths.legacyPermissions)).toBe(false);
  expect(readFileSync(paths.config, "utf8")).toContain(
    'allow = ["core__*", "memory__delete"] # mine',
  );
  expect(ivy.permissions.summary().allow).toEqual(["core__*", "memory__delete"]);
  expect(logs.join("\n")).toContain('moved 2 "Always" rule(s) from permissions.json');
});
