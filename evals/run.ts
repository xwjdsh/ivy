#!/usr/bin/env bun
// Run eval cases against a real model: `bun run eval [filter...] [--model m] [--provider p]`.
// Each case gets a fresh data folder with a copy of your config.toml (from $IVY_HOME or
// ./.ivy), so your own memory and sessions are never touched. Not part of `bun test`:
// every run calls the model and costs tokens.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createIvy, errorMessage, type Ivy, resolvePaths, Session } from "@ivy/kernel";
import core from "@ivy/plugin-core";
import { createMemoryPlugin } from "@ivy/plugin-memory";
import { TUI_INSTRUCTIONS } from "../packages/cli/src/interface.ts";
import type { EvalCase, Expect, MemoryFile, Pattern, StepRun } from "./eval.ts";
import memory from "./memory.ts";

const SUITES: Record<string, EvalCase[]> = { memory };
const FILES: MemoryFile[] = ["USER.md", "MEMORY.md", "ARCHIVE.md"];

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: "string" },
    provider: { type: "string" },
    config: { type: "string" },
    verbose: { type: "boolean", short: "v" },
  },
});

const configPath =
  values.config ?? join(process.env.IVY_HOME ?? join(process.cwd(), ".ivy"), "config.toml");
if (!existsSync(configPath)) {
  console.error(`No config at ${configPath}; pass --config <path>.`);
  process.exit(1);
}
const baseConfig = readFileSync(configPath, "utf8");

const selected = Object.entries(SUITES).flatMap(([suite, cases]) =>
  cases
    .map((c) => ({ id: `${suite}/${c.name}`, case: c }))
    .filter(({ id }) => positionals.length === 0 || positionals.some((p) => id.includes(p))),
);
if (selected.length === 0) {
  console.error(`No case matches ${positionals.join(" ")}.`);
  process.exit(1);
}

const root = mkdtempSync(join(tmpdir(), "ivy-eval-"));
let passed = 0;
let label = "";
for (const { id, case: c } of selected) {
  const started = Date.now();
  const failures = await runCase(c, join(root, id.replace("/", "-")));
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  if (failures.length === 0) passed++;
  console.log(`${failures.length === 0 ? "✓" : "✗"} ${id} (${secs}s)`);
  for (const f of failures) console.log(`    ${f.replace(/\n/g, "\n    ")}`);
}
console.log(`\n${passed}/${selected.length} passed · ${label} · data in ${root}`);
process.exit(passed === selected.length ? 0 : 1);

async function runCase(c: EvalCase, home: string): Promise<string[]> {
  mkdirSync(join(home, "data", "memory"), { recursive: true });
  writeFileSync(
    join(home, "config.toml"),
    withOverrides(baseConfig) + (c.config ? `\n${c.config}` : ""),
  );
  for (const [name, text] of Object.entries(c.files ?? {})) {
    writeFileSync(join(home, "data", "memory", name), text);
  }

  let ivy: Ivy;
  try {
    ivy = await createIvy({
      plugins: [core, createMemoryPlugin()],
      paths: resolvePaths(home),
      confirm: async () => "deny", // nobody is there to answer; risky tools are refused
      interfaceInstructions: TUI_INSTRUCTIONS,
    });
  } catch (err) {
    return [`setup failed: ${errorMessage(err)}`];
  }
  if (values.model) ivy.agent.setModel(values.model);
  label = `${ivy.config.activeProvider.name} · ${ivy.agent.model}`;

  const failures: string[] = [];
  let session: Session | undefined;
  for (const [i, step] of c.steps.entries()) {
    if (!session || !step.sameSession) {
      session = Session.create(ivy.paths.sessions, ivy.agent.model);
      await ivy.systemPrompt.start(session.id);
    }
    const run: StepRun = { answer: "", tools: [], files: readFiles(home) };
    const calls = new Map<string, { name: string; input: unknown }>();
    const result = await ivy.agent.runTurn(session, step.say, {
      signal: new AbortController().signal,
      onEvent: (e) => {
        if (e.type === "text") run.answer += e.delta;
        if (e.type === "tool_call") calls.set(e.id, { name: e.name, input: e.input });
        if (e.type === "tool_result") {
          const call = calls.get(e.id) ?? { name: e.name, input: undefined };
          run.tools.push({ ...call, result: e.content, isError: e.isError });
        }
      },
    });
    run.files = readFiles(home);
    if (values.verbose) printStep(i, step.say, run);

    const where = `step ${i + 1} "${step.say}"`;
    if (result.stopReason === "error")
      failures.push(`${where}: model error: ${result.error ?? "?"}`);
    for (const problem of check(step.expect ?? {}, run)) {
      failures.push(`${where}: ${problem}\n  answer: ${oneLine(run.answer)}`);
    }
  }
  await ivy.plugins.teardown();
  return failures;
}

function check(expect: Expect, run: StepRun): string[] {
  const problems: string[] = [];
  if (expect.answer !== undefined) {
    const any = Array.isArray(expect.answer) ? expect.answer : [expect.answer];
    if (!any.some((p) => matches(run.answer, p))) {
      problems.push(`answer has none of ${any.map(show).join(", ")}`);
    }
  }
  for (const p of expect.answerNot ?? []) {
    if (matches(run.answer, p)) problems.push(`answer has ${show(p)}`);
  }
  if (expect.maxChars !== undefined && run.answer.trim().length > expect.maxChars) {
    problems.push(`answer is ${run.answer.trim().length} chars, over ${expect.maxChars}`);
  }
  const names = run.tools.map((t) => t.name);
  for (const name of expect.called ?? []) {
    if (!names.includes(name))
      problems.push(`${name} not called (called: ${names.join(", ") || "none"})`);
  }
  for (const name of expect.notCalled ?? []) {
    if (names.includes(name)) problems.push(`${name} called`);
  }
  for (const p of expect.inHot ?? []) {
    if (!matches(`${run.files["USER.md"]}\n${run.files["MEMORY.md"]}`, p)) {
      problems.push(`neither USER.md nor MEMORY.md has ${show(p)}`);
    }
  }
  for (const [file, want] of Object.entries(expect.files ?? {}) as Array<
    [MemoryFile, { has?: Pattern[]; hasNot?: Pattern[] }]
  >) {
    for (const p of want.has ?? []) {
      if (!matches(run.files[file], p)) problems.push(`${file} lacks ${show(p)}`);
    }
    for (const p of want.hasNot ?? []) {
      if (matches(run.files[file], p)) problems.push(`${file} has ${show(p)}`);
    }
  }
  const custom = expect.custom?.(run);
  if (custom) problems.push(custom);
  return problems;
}

function matches(text: string, p: Pattern): boolean {
  return typeof p === "string" ? text.toLowerCase().includes(p.toLowerCase()) : p.test(text);
}

function show(p: Pattern): string {
  return typeof p === "string" ? JSON.stringify(p) : String(p);
}

function readFiles(home: string): Record<MemoryFile, string> {
  const out = {} as Record<MemoryFile, string>;
  for (const f of FILES) {
    const path = join(home, "data", "memory", f);
    out[f] = existsSync(path) ? readFileSync(path, "utf8") : "";
  }
  return out;
}

/** --provider picks another [providers.*] entry from the same config. */
function withOverrides(config: string): string {
  if (!values.provider) return config;
  return config.replace(/^(\s*provider\s*=\s*).*$/m, `$1"${values.provider}"`);
}

function oneLine(text: string, max = 200): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t || "(empty)";
}

function printStep(i: number, say: string, run: StepRun): void {
  console.log(`  [${i + 1}] > ${say}`);
  for (const t of run.tools)
    console.log(`      ${t.isError ? "✗" : "⏺"} ${t.name} ${JSON.stringify(t.input)}`);
  console.log(`      ${oneLine(run.answer, 400)}`);
}
