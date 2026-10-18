// What an eval case is: a few turns with a real model, each followed by checks on the
// answer, the tools called and the memory files. Cases are data so a new problem becomes
// a new case; `custom` covers what the data form can't say.

/** Text checks: a string matches as a case-insensitive substring, a RegExp as written. */
export type Pattern = string | RegExp;

export type MemoryFile = "USER.md" | "MEMORY.md" | "ARCHIVE.md";

export interface Expect {
  /** The answer contains one of these (an array is "any of"; repeat the key for "all of"). */
  answer?: Pattern | Pattern[];
  /** The answer contains none of these. */
  answerNot?: Pattern[];
  /** At most this many characters in the answer. */
  maxChars?: number;
  /** These tools were called, e.g. "memory__save". */
  called?: string[];
  notCalled?: string[];
  /** Saved to a hot file, either one: the model may fairly pick `USER.md` or `MEMORY.md`. */
  inHot?: Pattern[];
  /** After the step, each file contains every pattern (`has`) and none of `hasNot`. */
  files?: Partial<Record<MemoryFile, { has?: Pattern[]; hasNot?: Pattern[] }>>;
  /** Anything else; return a reason to fail, or nothing. */
  custom?: (run: StepRun) => string | undefined;
}

export interface Step {
  /** What the user says. */
  say: string;
  /** Continue the previous step's session instead of starting a new one. */
  sameSession?: boolean;
  expect?: Expect;
}

export interface EvalCase {
  name: string;
  /** What this checks, and why it matters. */
  about: string;
  /** Extra config.toml text appended for this case, e.g. a small memory limit. */
  config?: string;
  /** Memory files written before the first step. */
  files?: Partial<Record<MemoryFile, string>>;
  steps: Step[];
}

/** What a step produced, for checks. */
export interface StepRun {
  answer: string;
  tools: Array<{ name: string; input: unknown; result: string; isError: boolean }>;
  files: Record<MemoryFile, string>;
}

export function defineEvals(cases: EvalCase[]): EvalCase[] {
  return cases;
}
