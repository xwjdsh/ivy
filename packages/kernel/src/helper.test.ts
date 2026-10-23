import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveHelperModel } from "./config-edit.ts";
import { createIvy, MemoryKeyStore, resolvePaths } from "./index.ts";
import { ScriptedModel, text } from "./testing.ts";

// A local endpoint, so the background model-list refresh never reaches the network.
const CONFIG = `[agent]\nmodel = "proxy/main-model"\n[providers.proxy]\napi_key = "k"\nbase_url = "http://127.0.0.1:9"\n`;

async function ivyWith(extra = "") {
  const paths = resolvePaths(mkdtempSync(join(tmpdir(), "ivy-helper-")));
  writeFileSync(paths.config, CONFIG.replace("[agent]\n", `[agent]\n${extra}`));
  const model = new ScriptedModel([{ content: [text("the answer")] }]);
  const ivy = await createIvy({ plugins: [], paths, keys: new MemoryKeyStore(), model });
  return { ivy, model, paths };
}

test("side work runs on the helper model, with no tools", async () => {
  const { ivy, model } = await ivyWith('helper_model = "proxy/small-model"\n');
  const answer = await ivy.helper.complete({ system: "Sum up.", prompt: "A long page" });
  expect(answer).toBe("the answer");
  const [request] = model.requests;
  expect(request?.model).toBe("small-model");
  expect(request?.tools).toBeUndefined();
  expect(request?.output_config).toBeUndefined();
});

test("without a helper model, side work runs on the main model at low effort", async () => {
  const { ivy, model } = await ivyWith();
  expect(ivy.helper.separate).toBe(false);
  await ivy.helper.complete({ system: "Sum up.", prompt: "A long page" });
  expect(model.requests[0]?.model).toBe("main-model");
  expect(model.requests[0]?.output_config).toEqual({ effort: "low" });
});

test("the helper model is saved, taken out, and checked against the providers", async () => {
  const { paths } = await ivyWith();
  expect(saveHelperModel(paths, "proxy/small-model").agent.helper_model).toBe("proxy/small-model");
  expect(saveHelperModel(paths, undefined).agent.helper_model).toBeUndefined();
  expect(() => saveHelperModel(paths, "nowhere/model")).toThrow("helper_model");
});
