import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { definePlugin, type WriterModel } from "@ivy/plugin-api";
import { createIvy, MemoryKeyStore, resolvePaths } from "./index.ts";
import { ScriptedModel, type Step, text } from "./testing.ts";

test("Ivy's writer: the main model, her rules, SOUL and session sections, the task; no tools", async () => {
  const paths = resolvePaths(mkdtempSync(join(tmpdir(), "ivy-writer-")));
  // A local endpoint, so the background model-list refresh never reaches the network.
  writeFileSync(
    paths.config,
    '[agent]\nmodel = "proxy/main-model"\nhelper_model = "proxy/small"\n[providers.proxy]\napi_key = "k"\nbase_url = "http://127.0.0.1:9"\n',
  );
  writeFileSync(paths.soul, "You are warm and blunt.");
  let writer: WriterModel | undefined;
  const released: string[] = [];
  const memory = definePlugin({
    id: "mem",
    version: "0",
    description: "",
    setup(ctx) {
      writer = ctx.writer;
    },
    sessionPrompt: () => "# Memory\nThe user has a cat called 豆豆.",
    sessionReleased: ({ id }) => {
      released.push(id);
    },
  });
  const model = new ScriptedModel([{ content: [text("## Said\n…")] }]);
  await createIvy({ plugins: [memory], paths, keys: new MemoryKeyStore(), model, sumUp: false });
  expect(await writer?.complete({ system: "Write the day's note.", prompt: "User: hi" })).toBe(
    "## Said\n…",
  );
  const [request] = model.requests;
  expect(request?.model).toBe("main-model");
  expect(request?.tools).toBeUndefined();
  const system = JSON.stringify(request?.system);
  for (const part of [
    "# Operating rules",
    "You are warm and blunt.",
    "豆豆",
    "# Task\\nWrite the day's note.",
  ]) {
    expect(system).toContain(part);
  }
  // Its session section was built for this once, and let go.
  expect(released).toHaveLength(1);
  expect(released[0]).toStartWith("writer-");
});

async function writerWith(script: Step[]) {
  const paths = resolvePaths(mkdtempSync(join(tmpdir(), "ivy-writer-")));
  writeFileSync(
    paths.config,
    '[agent]\nmodel = "proxy/main-model"\n[providers.proxy]\napi_key = "k"\nbase_url = "http://127.0.0.1:9"\n',
  );
  let writer: WriterModel | undefined;
  const p = definePlugin({
    id: "p",
    version: "0",
    description: "",
    setup(ctx) {
      writer = ctx.writer;
    },
  });
  const model = new ScriptedModel(script);
  await createIvy({ plugins: [p], paths, keys: new MemoryKeyStore(), model, sumUp: false });
  if (!writer) throw new Error("no writer");
  return { writer, model };
}

test("an answer cut off is an error, not a note half written; a refused effort is dropped once", async () => {
  const cut = await writerWith([{ content: [text("## Said\nThe user to")], stop: "max_tokens" }]);
  await expect(cut.writer.complete({ system: "s", prompt: "p" })).rejects.toThrow("cut off");

  const refuse: Step = async () => {
    throw Anthropic.APIError.generate(
      400,
      { error: { message: "output_config.effort: not supported" } },
      "output_config.effort: not supported",
      new Headers(),
    );
  };
  const { writer, model } = await writerWith([refuse, { content: [text("ok")] }]);
  expect(await writer.complete({ system: "s", prompt: "p" })).toBe("ok");
  expect(model.requests[1]?.output_config).toBeUndefined();
});
