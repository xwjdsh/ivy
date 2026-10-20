import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Served, serve } from "@ivy/daemon";
import { resolvePaths } from "@ivy/kernel";
import { DaemonClient } from "./client.ts";
import { runPlain } from "./plain.ts";

let served: Served | undefined;
afterEach(async () => {
  await served?.stop();
  served = undefined;
});

test("a turn that fails at once still ends one-shot mode, with its error", async () => {
  const home = mkdtempSync(join(tmpdir(), "ivy-p-"));
  writeFileSync(
    join(home, "config.toml"),
    '[agent]\nmodel = "anthropic/claude-opus-5-5"\n[providers.anthropic]\napi_key = "test"\n',
  );
  served = await serve({
    paths: resolvePaths(home),
    plugins: [],
    // Fails before any network round trip: the turn can end before `send` returns.
    model: {
      stream: async () => {
        throw new Error("endpoint down");
      },
    },
  });
  const client = new DaemonClient(served.ivy.paths.daemonSocket);
  const session = await client.createSession("plain");
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const end = await runPlain(client, session, "hi", false);
    expect(end).toMatchObject({ stopReason: "error", error: "endpoint down" });
  } finally {
    stderr.mockRestore();
  }
});
