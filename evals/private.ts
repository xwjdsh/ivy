// Cases cut from the user's own conversations: JSON files in $IVY_HOME/evals/, one suite per
// file (`private-<file>`; `settings.json` there is the runner's, not cases). They hold what the user confided, so they live with the user's data
// and never in the repository. The same shape as a case here, with what JSON can't hold
// spelled out: a pattern "/re/flags" is a RegExp, `"judge": "company"` the COMPANY criteria,
// `"soul"` and `"files"` "user" the user's own SOUL.md and memory files, "starter" the
// starter SOUL.md.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePaths } from "@ivy/kernel";
import { COMPANY, type EvalCase, type Expect, type MemoryFile, type Pattern } from "./eval.ts";

const STARTER = join(import.meta.dir, "..", "examples", "SOUL.md");
const MEMORY_FILES: MemoryFile[] = ["USER.md", "MEMORY.md", "ARCHIVE.md", "IVY.md"];

type JsonPattern = string;
interface JsonExpect
  extends Omit<Expect, "answer" | "answerNot" | "judge" | "custom" | "inHot" | "files"> {
  answer?: JsonPattern | JsonPattern[];
  answerNot?: JsonPattern[];
  judge?: "company" | string[];
}
interface JsonCase extends Omit<EvalCase, "soul" | "files" | "steps"> {
  soul?: "user" | "starter" | string;
  files?: "user" | Partial<Record<MemoryFile, string>>;
  steps: Array<{ say: string; sameSession?: boolean; expect?: JsonExpect }>;
}

export function privateSuites(home: string): Record<string, EvalCase[]> {
  const dir = join(home, "evals");
  if (!existsSync(dir)) return {};
  const suites: Record<string, EvalCase[]> = {};
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "settings.json")
    .sort()) {
    const cases = JSON.parse(readFileSync(join(dir, file), "utf8")) as JsonCase[];
    suites[`private-${file.replace(/\.json$/, "")}`] = cases.map((c) => toCase(c, home));
  }
  return suites;
}

function toCase(c: JsonCase, home: string): EvalCase {
  return {
    ...c,
    soul:
      c.soul === "user"
        ? readFileSync(resolvePaths(home).soul, "utf8")
        : c.soul === "starter"
          ? readFileSync(STARTER, "utf8")
          : c.soul,
    files: c.files === "user" ? userFiles(home) : c.files,
    steps: c.steps.map((s) => ({ ...s, expect: s.expect && toExpect(s.expect) })),
  };
}

function toExpect(e: JsonExpect): Expect {
  return {
    ...e,
    answer:
      e.answer === undefined
        ? undefined
        : Array.isArray(e.answer)
          ? e.answer.map(pattern)
          : pattern(e.answer),
    answerNot: e.answerNot?.map(pattern),
    judge: e.judge === "company" ? COMPANY : e.judge,
  };
}

/** "/re/flags" is a RegExp; anything else a substring. */
function pattern(p: JsonPattern): Pattern {
  const m = /^\/(.+)\/([a-z]*)$/.exec(p);
  return m ? new RegExp(m[1] ?? "", m[2]) : p;
}

/** The user's memory files as they are now, for a case about how Ivy meets them. */
function userFiles(home: string): Partial<Record<MemoryFile, string>> {
  const data = resolvePaths(home).data;
  const files: Partial<Record<MemoryFile, string>> = {};
  for (const f of MEMORY_FILES) {
    const path = join(data, f === "IVY.md" ? "journal" : "memory", f);
    if (existsSync(path)) files[f] = readFileSync(path, "utf8");
  }
  return files;
}
