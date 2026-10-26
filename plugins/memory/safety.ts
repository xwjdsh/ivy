// Memory is put into every session's prompt, so it must not become a way in: text saved
// from a web page or an email could otherwise turn into a standing instruction.
//
// - Writes (the model's) are strict: anything found is rejected.
// - Reads are lenient: lines Ivy didn't write are the user's own, so only hidden
//   characters (which a paste can carry without anyone noticing) keep a line out of what
//   the model sees; the other findings are only pointed out in /memory.
//
// The rules are narrow on purpose. A false positive blocks a real memory, so each one
// targets something that has no place in a fact about the user: hidden characters, text
// addressed to the model, chat-format markup, and secrets.

import type { Line } from "./format.ts";
import { FILES, type FileName, type Files } from "./store.ts";

export interface Finding {
  kind: "hidden" | "instruction" | "secret";
  reason: string;
}

/** What is wrong with a text, or null when it is fine. */
export function scan(text: string): Finding | null {
  const hidden = HIDDEN.exec(text);
  if (hidden) {
    const code = (hidden[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
    return {
      kind: "hidden",
      reason: `it contains an invisible or text-direction character (U+${code}), which can hide text`,
    };
  }
  for (const [pattern, what] of INSTRUCTIONS) {
    if (pattern.test(text)) {
      return { kind: "instruction", reason: `it reads like ${what} aimed at the assistant` };
    }
  }
  for (const [pattern, what] of SECRETS) {
    if (pattern.test(text)) return { kind: "secret", reason: `it looks like a secret (${what})` };
  }
  return null;
}

// Zero-width and invisible characters, text-direction overrides, Unicode "tag" characters
// (invisible ASCII look-alikes used to smuggle text), and control characters. Zero-width
// (non-)joiners stay allowed: emoji sequences and some scripts need them.
// Written as escapes on purpose: the characters themselves are invisible.
const HIDDEN_RANGES =
  "\\u0000-\\u0008\\u000B-\\u001F\\u007F\\u061C\\u200B\\u200E\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u{E0000}-\\u{E007F}";
const HIDDEN = new RegExp(`[${HIDDEN_RANGES}]`, "u");

const INSTRUCTIONS: Array<[RegExp, string]> = [
  [
    /\b(ignore|disregard|forget|override)\b.{0,30}\b(previous|prior|above|earlier|all|your|system)\b.{0,20}\b(instructions?|rules|prompts?|messages)\b/i,
    'an instruction ("ignore previous instructions")',
  ],
  [
    /(忽略|无视|忘记|忘掉).{0,8}(之前|以上|前面|先前|所有|系统).{0,6}(指令|规则|提示|指示)/u,
    "an instruction (忽略之前的指令)",
  ],
  [/\b(you are now|from now on,? you (are|will|must)|new instructions:)/i, "a role change"],
  [/(从现在起你|你现在是一个|你现在扮演)/u, "a role change"],
  [
    /<\/?\s*(system|assistant|user|human|developer|tool|tool_use|tool_result|function_calls|invoke|instructions?)\b[^>]*>|<\|[a-z_]+\|>|\[\/?INST\]|<<\/?SYS>>/i,
    "chat-format markup",
  ],
];

const SECRETS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\bsk-[A-Za-z0-9_-]{20,}/, "an API key"],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{20,}/, "a GitHub token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "a Google API key"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, "a JSON web token"],
];

/**
 * Lines as the model may see them. Lines with hidden characters are left out of the
 * prompt, search results and due reminders; other findings stay in and are only noted.
 * Writes still work on the full files, so nothing is ever deleted by this.
 */
export function visible(lines: Line[]): {
  lines: Line[];
  skipped: Array<{ line: string; finding: Finding }>;
  flagged: Array<{ line: string; finding: Finding }>;
} {
  const skipped: Array<{ line: string; finding: Finding }> = [];
  const flagged: Array<{ line: string; finding: Finding }> = [];
  const shown = lines.filter((line) => {
    const finding = scan(line.raw);
    if (!finding) return true;
    (finding.kind === "hidden" ? skipped : flagged).push({ line: line.raw, finding });
    return finding.kind !== "hidden";
  });
  return { lines: shown, skipped, flagged };
}

export interface Noted {
  file: FileName;
  line: string;
  finding: Finding;
}

/** Memory's files as the model may see them (see `visible`), noting what was found where. */
export function screen(files: Files): { files: Files; skipped: Noted[]; flagged: Noted[] } {
  const skipped: Noted[] = [];
  const flagged: Noted[] = [];
  const shown = { ...files };
  for (const file of FILES) {
    const v = visible(files[file]);
    shown[file] = v.lines;
    skipped.push(...v.skipped.map((n) => ({ file, ...n })));
    flagged.push(...v.flagged.map((n) => ({ file, ...n })));
  }
  return { files: shown, skipped, flagged };
}
