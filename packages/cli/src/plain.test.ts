import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Served, serve } from "@ivy/daemon";
import { resolvePaths } from "@ivy/kernel";
import type { Prompt } from "@ivy/protocol";
import { DaemonClient } from "./client.ts";
import { runPlain } from "./plain.ts";

let served: Served | undefined;
afterEach(async () => {
  await served?.stop();
  served = undefined;
});

/** A client whose `send` returns only after the turn it started has ended (seen by another client). */
class LateSend extends DaemonClient {
  private readonly ended = new Set<string>();
  private readonly watching = new AbortController();
  constructor(socket: string) {
    super(socket);
    void new DaemonClient(socket).follow((e) => {
      if (e.type === "turn_end") this.ended.add(e.promptId);
    }, this.watching.signal);
  }
  override send = async (id: string, text: string) => {
    const prompt = await this.request<Prompt>("POST", `/sessions/${id}/prompts`, { text });
    while (!this.ended.has(prompt.id)) await Bun.sleep(5);
    await Bun.sleep(50); // and the caller's own stream has it too
    this.watching.abort();
    return prompt;
  };
}

test("a turn that ends before `send` returns still ends one-shot mode, with its error", async () => {
  const home = mkdtempSync(join(tmpdir(), "ivy-p-"));
  writeFileSync(
    join(home, "config.toml"),
    '[agent]\nmodel = "anthropic/claude-opus-5-5"\n[providers.anthropic]\napi_key = "test"\n',
  );
  served = await serve({
    paths: resolvePaths(home),
    plugins: [],
    model: {
      stream: async () => {
        throw new Error("endpoint down");
      },
    },
  });
  const client = new LateSend(served.ivy.paths.daemonSocket);
  const session = await client.createSession("plain");
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const end = await runPlain(client, session, "hi", false);
    expect(end).toMatchObject({ stopReason: "error", error: "endpoint down" });
  } finally {
    stderr.mockRestore();
  }
}, 5000);
