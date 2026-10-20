import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIvy, resolvePaths } from "./index.ts";

test("a missing API key fails at startup, naming the provider", async () => {
  const paths = resolvePaths(mkdtempSync(join(tmpdir(), "ivy-key-")));
  writeFileSync(paths.config, '[agent]\nmodel = "proxy/m"\n[providers.proxy]\n');
  await expect(createIvy({ plugins: [], paths })).rejects.toThrow(
    "Set api_key under [providers.proxy]",
  );
});
