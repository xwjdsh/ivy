#!/usr/bin/env bun

// Run eval cases against a real model:
// `bun run eval [filter...] [--model provider/model] [--judge provider/model] [--no-judge]`.
// The model is your config's unless `--model` says; the judge is `--judge`, else the one in
// $IVY_HOME/evals/settings.json (`{"judge": "provider/model"}`), else the model under test.
// Each case gets a fresh data folder with a copy of your config.toml (from $IVY_HOME or
// ~/.ivy), so your own memory and sessions are never touched. Not part of `bun test`:
// every run calls the model and costs tokens.
//
// Besides the suites here, cases cut from your own conversations live in $IVY_HOME/evals/
// as JSON (private.ts), never in the repository.

import { setSystemTime } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DISPLAY_INSTRUCTIONS } from "@ivy/daemon";
import {
  createIvy,
  errorMessage,
  type Ivy,
  resolveModel,
  resolvePaths,
  Session,
} from "@ivy/kernel";
import core from "@ivy/plugin-core";
import { createJournalPlugin } from "@ivy/plugin-journal";
import { createMemoryPlugin } from "@ivy/plugin-memory";
import basics from "./basics.ts";
import company from "./company.ts";
import {
  type EvalCase,
  type Expect,
  type MemoryFile,
  type Pattern,
  type Step,
  type StepRun,
  styleProblems,
} from "./eval.ts";
import journal from "./journal.ts";
import { judge } from "./judge.ts";
import keep from "./keep.ts";
import memory from "./memory.ts";
import { privateSuites } from "./private.ts";
import recall from "./recall.ts";

const SUITES: Record<string, EvalCase[]> = {
  basics,
  company,
  journal,
  keep,
  memory,
  recall,
  ...privateSuites(resolvePaths().home),
};
const FILES: MemoryFile[] = ["USER.md", "MEMORY.md", "ARCHIVE.md", "IVY.md"];
/** Where each file lives under the data folder: IVY.md belongs to the journal plugin. */
const fileDir = (f: MemoryFile) => (f === "IVY.md" ? "journal" : "memory");
const filePath = (home: string, f: MemoryFile) => join(resolvePaths(home).data, fileDir(f), f);
/** The archive, a file per topic; a case's ARCHIVE.md is the archive as it was before topics. */
const archiveDir = (home: string) => join(resolvePaths(home).data, "memory", "archive");

/** Write a memory file as a case gives it; ARCHIVE.md is the archive's general topic. */
function writeMemory(home: string, name: MemoryFile, text: string): void {
  if (name === "ARCHIVE.md") {
    mkdirSync(archiveDir(home), { recursive: true });
    writeFileSync(join(archiveDir(home), "general.md"), text);
  } else {
    writeFileSync(filePath(home, name), text);
  }
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: "string" },
    judge: { type: "string" },
    "no-judge": { type: "boolean" },
    config: { type: "string" },
    verbose: { type: "boolean", short: "v" },
  },
});

const configPath = values.config ?? join(resolvePaths().home, "config.toml");
if (!existsSync(configPath)) {
  console.error(`No config at ${configPath}; pass --config <path>.`);
  process.exit(1);
}
const baseConfig = readFileSync(configPath, "utf8");

/** The judge: `--judge`, else the one in $IVY_HOME/evals/settings.json, else the model under test. */
const settingsFile = join(resolvePaths().home, "evals", "settings.json");
const judgeRef =
  values.judge ??
  (existsSync(settingsFile)
    ? (JSON.parse(readFileSync(settingsFile, "utf8")) as { judge?: string }).judge
    : undefined);

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
/** The judge's scores, one per judged step. */
const scores: number[] = [];
/** Every reply, for the counts that a judge's verdicts are too noisy to show. */
const replies: string[] = [];
for (const { id, case: c } of selected) {
  const started = Date.now();
  const failures = await runCase(c, join(root, id.replace("/", "-")));
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  if (failures.length === 0) passed++;
  console.log(`${failures.length === 0 ? "✓" : "✗"} ${id} (${secs}s)`);
  for (const f of failures) console.log(`    ${f.replace(/\n/g, "\n    ")}`);
}
const average = scores.length
  ? ` · judged ${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)}/5 over ${scores.length}`
  : "";
console.log(`\n${passed}/${selected.length} passed${average} · ${label} · data in ${root}`);
console.log(styleCounts(replies));
process.exit(passed === selected.length ? 0 : 1);

/**
 * The case's clock: today at its time of day, going on as the case runs, so a reply never
 * depends on when the evals happen to run (an after-work case at 11:00 got "already off?").
 */
function caseClock(at = "20:00"): () => void {
  const [h = 20, m = 0] = at.split(":").map(Number);
  const start = new Date();
  start.setHours(h, m, 0, 0);
  const began = performance.now();
  return () => setSystemTime(new Date(start.getTime() + (performance.now() - began)));
}

async function runCase(c: EvalCase, home: string): Promise<string[]> {
  const tick = caseClock(c.at);
  try {
    return await runSteps(c, home, tick);
  } finally {
    setSystemTime(); // the real clock again
  }
}

async function runSteps(c: EvalCase, home: string, tick: () => void): Promise<string[]> {
  tick();
  const paths = resolvePaths(home);
  for (const dir of ["memory", "journal"]) mkdirSync(join(paths.data, dir), { recursive: true });
  if (c.soul) writeFileSync(paths.soul, c.soul);
  writeFileSync(paths.config, baseConfig + (c.config ? `\n${c.config}` : ""));
  for (const [name, text] of Object.entries(c.files ?? {})) {
    writeMemory(home, name as MemoryFile, text);
  }
  for (const [topic, text] of Object.entries(c.topics ?? {})) {
    mkdirSync(archiveDir(home), { recursive: true });
    writeFileSync(join(archiveDir(home), `${topic}.md`), text);
  }

  let ivy: Ivy;
  try {
    ivy = await createIvy({
      plugins: [core, createMemoryPlugin(), createJournalPlugin()],
      paths,
    });
    if (values.model) ivy.agent.setModel(values.model);
  } catch (err) {
    return [`setup failed: ${errorMessage(err)}`];
  }
  label = ivy.agent.model;

  const failures: string[] = [];
  let session: Session | undefined;
  // What the judge sees: the conversation before the step being judged, then what was said.
  const conversation = [...(c.history ?? [])];
  for (const [i, step] of c.steps.entries()) {
    tick();
    if (step.clearMemory) {
      for (const f of ["USER.md", "MEMORY.md"] as const) writeFileSync(filePath(home, f), "");
      rmSync(archiveDir(home), { recursive: true, force: true });
    }
    for (const [name, text] of Object.entries(step.files ?? {})) {
      writeMemory(home, name as MemoryFile, text);
    }
    if (!session || !step.sameSession) {
      session = Session.create(ivy.paths.sessions, ivy.agent.model);
      await ivy.systemPrompt.start(session.id, DISPLAY_INSTRUCTIONS.markdown);
      // The case's earlier conversation goes into its first session, as it was.
      if (i === 0) {
        for (const m of c.history ?? []) {
          // As a turn would: what the user says starts a turn (and ends a taint); a reply
          // after outside content is marked so.
          if (m.role === "user") {
            session.appendPrompt(m.text, "");
          } else {
            if (m.outside) session.markOutside("eval");
            session.append({ role: m.role, content: m.text });
          }
        }
      } else {
        conversation.length = 0;
      }
    }
    if (step.job) {
      failures.push(...(await runJob(ivy, step, home)));
      continue;
    }
    const run: StepRun = { answer: "", tools: [], files: readFiles(home) };
    // What Ivy knew for this turn, for the judge: her system prompt (rules, SOUL.md, memory),
    // the turn's context.
    const knew = { system: await ivy.systemPrompt.textFor(session.id), context: "" };
    const calls = new Map<string, { name: string; input: unknown }>();
    const result = await ivy.agent.runTurn(session, step.say, {
      signal: new AbortController().signal,
      confirm: async () => "deny", // nobody is there to answer; risky tools are refused
      onEvent: (e) => {
        if (e.type === "text") run.answer += e.delta;
        if (e.type === "context") knew.context = e.text;
        if (e.type === "tool_call") calls.set(e.id, { name: e.name, input: e.input });
        if (e.type === "tool_result") {
          const call = calls.get(e.id) ?? { name: e.name, input: undefined };
          run.tools.push({ ...call, result: e.content, isError: e.isError });
        }
      },
    });
    run.files = readFiles(home);
    replies.push(run.answer);
    if (values.verbose) printStep(i, step.say, run);

    const where = `step ${i + 1} "${step.say}"`;
    if (result.stopReason === "error")
      failures.push(`${where}: model error: ${result.error ?? "?"}`);
    for (const problem of check(step.expect ?? {}, run, step.say)) {
      failures.push(`${where}: ${problem}\n  answer: ${oneLine(run.answer)}`);
    }
    if (step.expect?.judge && !values["no-judge"] && result.stopReason !== "error") {
      try {
        const said = [...conversation, { role: "user" as const, text: step.say }];
        const verdict = await judgeWith(ivy, said, known(knew, run), run.answer, step.expect.judge);
        scores.push(verdict.score);
        if (values.verbose) console.log(`      judged ${verdict.score}/5`);
        for (const v of verdict.criteria.filter((x) => !x.pass)) {
          failures.push(
            `${where}: judged against: ${v.criterion}\n  ${v.reason}\n  answer: ${oneLine(run.answer)}`,
          );
        }
      } catch (err) {
        failures.push(`${where}: judge failed: ${errorMessage(err)}`);
      }
    }
    conversation.push({ role: "user", text: step.say }, { role: "assistant", text: run.answer });
  }
  await ivy.plugins.teardown();
  return failures;
}

/**
 * A plugin's job run as at 05:00 the next day, over everything since 00:00 today: the case's
 * day has ended and is the job's to look back on. A day starts at 04:00, so the window also
 * takes in yesterday, where a case set before 04:00 has its talk.
 */
async function runJob(ivy: Ivy, step: Step, home: string): Promise<string[]> {
  const job = ivy.plugins.jobs().find((j) => j.name === step.job);
  if (!job) return [`no job "${step.job}"`];
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const now = new Date(since.getTime() + 29 * 3_600_000); // 05:00 tomorrow
  try {
    await job.run({ now, since, signal: new AbortController().signal });
  } catch (err) {
    return [`job ${step.job} failed: ${errorMessage(err)}`];
  }
  const run: StepRun = { answer: "", tools: [], files: readFiles(home) };
  return check(step.expect ?? {}, run, "").map((p) => `job ${step.job}: ${p}`);
}

/** Over every reply: how many asked more than one question or held a list, and how long. */
function styleCounts(all: string[]): string {
  if (all.length === 0) return "";
  const questions = all.filter((r) => (r.match(/[?？]/g) ?? []).length > 1).length;
  const lists = all.filter((r) => /^\s*([-*] |\d+\. )/m.test(r)).length;
  const lengths = all.map((r) => [...r.trim()].length).sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)] ?? 0;
  return `style: ${all.length} replies · ${questions} with 2+ questions · ${lists} with a list · median ${median} chars`;
}

/** The judge model, or the model under test. */
function judgeWith(
  ivy: Ivy,
  conversation: Array<{ role: "user" | "assistant"; text: string }>,
  knew: string,
  answer: string,
  criteria: string[],
) {
  const target = resolveModel(ivy.config.providers, judgeRef ?? ivy.agent.model);
  return judge(ivy.clientFor(target.provider), target.id, conversation, knew, answer, criteria);
}

/**
 * What Ivy had in front of her for a turn, so the judge doesn't take it for invention: her
 * system prompt (rules, SOUL.md, memory), the turn's context (the time, due todos), what her
 * tools found.
 */
function known(knew: { system: string; context: string }, run: StepRun): string {
  const tools = run.tools.map((t) => `${t.name} ${JSON.stringify(t.input)} →\n${t.result}`);
  return [
    `Her system prompt:\n${knew.system}`,
    ...(knew.context ? [`This turn's context:\n${knew.context}`] : []),
    ...(tools.length ? [`What her tools returned:\n${tools.join("\n")}`] : []),
  ].join("\n\n");
}

function check(expect: Expect, run: StepRun, said: string): string[] {
  const problems: string[] = [];
  if (expect.style) problems.push(...styleProblems(run.answer, said));
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
    const path = filePath(home, f);
    out[f] = existsSync(path) ? readFileSync(path, "utf8") : "";
  }
  // The archive is every topic's file, one after another.
  const dir = archiveDir(home);
  if (existsSync(dir)) {
    out["ARCHIVE.md"] = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("\n");
  }
  return out;
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
