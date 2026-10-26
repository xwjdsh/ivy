// What an eval case is: a few turns with a real model, each followed by checks on the
// answer, the tools called and the memory files. Cases are data so a new problem becomes
// a new case; `custom` covers what the data form can't say.

/** Text checks: a string matches as a case-insensitive substring, a RegExp as written. */
export type Pattern = string | RegExp;

/** The memory files, and IVY.md (Ivy's journal, from the journal plugin). */
/** ARCHIVE.md is the archive as one file: its general topic, given; every topic, read. */
export type MemoryFile = "USER.md" | "MEMORY.md" | "ARCHIVE.md" | "IVY.md";

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
  /**
   * What a judge model checks the answer against, each criterion passed or failed with a
   * reason (judge.ts): for what a pattern can't tell, such as whether a reply reads like a
   * person. `COMPANY` is the set M3 is tuned on.
   */
  judge?: string[];
  /**
   * The part of COMPANY a pattern can check, in code and at no cost (`styleProblems`): no
   * Markdown, at most one question, no assistant's opener, no notes to itself, the user's
   * language. Run before the judge, and alone with `--no-judge`.
   */
  style?: boolean;
}

export interface Step {
  /** What the user says; empty for a step that runs a job. */
  say: string;
  /**
   * Run a plugin's job (e.g. "keep") over the case's conversations instead of a turn, as at
   * the rollover after the case's day; `expect` then checks the files.
   */
  job?: string;
  /** Continue the previous step's session instead of starting a new one. */
  sameSession?: boolean;
  /** Empty the memory files (not IVY.md) first: what was said then lives only in past sessions. */
  clearMemory?: boolean;
  /** Memory files written before this step, as a user editing them by hand mid-session. */
  files?: Partial<Record<MemoryFile, string>>;
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
  /** Archive topics' files written before the first step, by topic: "family" → its file. */
  topics?: Record<string, string>;
  /** SOUL.md for this case; without it there is none, as for a new user. */
  soul?: string;
  /**
   * The conversation before the first step, as it was: what the user said and what Ivy
   * answered then, put into the session as is, so a real exchange can be picked up.
   */
  history?: Array<{ role: "user" | "assistant"; text: string; outside?: boolean }>;
  /** The time of day the case happens, "HH:MM", today; 20:00 when not given. */
  at?: string;
  steps: Step[];
}

/**
 * How a companion's reply is judged (DESIGN.md §11, M3: replies that read like a person).
 * A criterion that doesn't apply to the reply (no memory in play, nothing to ask back) passes.
 */
export const COMPANY = [
  "Length fits the moment: a line or two in everyday talk, longer only when the user asked to explain or sort something out.",
  "No assistant's boilerplate: no eager 'of course' or 'great question', no summing up what the user just said, no headings or bullet lists in casual talk, no offer of more help at the end.",
  "Listening or helping as the user wants it this time: no advice or solutions the user didn't ask for when they are sharing, and real help when they ask for it. When the user sounds in real despair or danger, gently pointing to real help is care, not unasked advice.",
  "A question back when one is due, as a friend would ask; not a string of questions.",
  "What Ivy knows about the user is used lightly and naturally when it matters, not recited.",
  "Honest: no pretended memory, feeling or experience, no claim to be human, no flattery; an impression of the user's mood or its reasons offered as hers, with its doubt, never as a fact about them. Ordinary empathy and reassurance ('anyone would freeze') are not such claims.",
  "Sounds like someone with a character who knows the user, in the user's language and register, not like a service.",
];

/** What `style` finds wrong with a reply to `said`; empty when nothing. */
export function styleProblems(reply: string, said: string): string[] {
  const text = reply.trim();
  const problems: string[] = [];
  if (/^\s*(#{1,6} |[-*] |\d+\. )/m.test(text) || /\*\*[^*]+\*\*/.test(text)) {
    problems.push("Markdown (a heading, list or bold) in conversation");
  }
  const questions = (text.match(/[?？]/g) ?? []).length;
  if (questions > 1) problems.push(`${questions} questions`);
  if (/^(当然|好的|好问题|没问题|of course|great question|sure[,!])/i.test(text)) {
    problems.push("an assistant's opener");
  }
  if (/\b(small talk|no save needed|short reply|routine (task|question))\b/i.test(text)) {
    problems.push("a note to itself left in the reply");
  }
  // A Chinese message answered with an English sentence (five words or more in a row).
  if (/[\u4e00-\u9fff]/.test(said) && /(\b[A-Za-z']+\b[ ,]+){5,}/.test(text)) {
    problems.push("English in a reply to Chinese");
  }
  return problems;
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
