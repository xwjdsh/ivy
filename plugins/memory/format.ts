// The memory files' line format. One entry per line:
//
//   - [todo 2026-10-17 due:2026-10-21] Dentist appointment at 15:00 #health #牙医
//
// Inside the brackets: the type (none in USER.md), the date the line was written, changed
// or confirmed, then optional fields and flags; `topic:family` on a hot entry is the topic
// of the archive it goes to (in a topic's file, the file says it). Tags go at the end. Anything else in a file
// (headings, notes, hand-written lines) is kept byte for byte; only lines Ivy changes are
// rewritten, so hand edits never break and never get reformatted.

export const ENTRY_TYPES = ["fact", "note", "todo", "follow"] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

/** Entries with a time: a todo the user is reminded of, a follow-up Ivy brings up herself. */
export const timed = (type: EntryType | undefined): boolean => type === "todo" || type === "follow";

/** Date fields, in the order they are written. */
export const DATE_FIELDS = ["since", "ends", "due", "done", "until", "replaced"] as const;
export type DateField = (typeof DATE_FIELDS)[number];

export interface Entry {
  type?: EntryType;
  /** YYYY-MM-DD: written, last changed or last confirmed. */
  date?: string;
  fields: Partial<Record<DateField, string>>;
  /** Saved from outside content (a tainted session). */
  ext: boolean;
  /** The archive topic it belongs to: its file's, or, on a hot entry, where it goes. */
  topic?: string;
  /** Bracket tokens Ivy doesn't know, kept as they are. */
  unknown: string[];
  text: string;
  tags: string[];
}

export interface Line {
  /** The line exactly as it is in the file. */
  raw: string;
  /** Set for entry lines ("- ..."); other lines are kept but never touched. */
  entry?: Entry;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ENTRY_RE = /^- (?:\[([^\]]*)\]\s*)?(.*)$/;
// A trailing tag: "#" + characters with at least one letter, so "Room #12" stays text.
const TAG_RE = /\s#((?=[^\s#]*\p{L})[^\s#]+)$/u;

/** A topic's name, as files and tools have it: "family", "friend-ken". */
export function isTopic(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,39}$/.test(value);
}

export function isDate(value: string): boolean {
  return DATE_RE.test(value) && !Number.isNaN(Date.parse(value));
}

/** A due value: a date, or a date and time ("2026-10-18T17:00") when the todo has one. */
export function isDue(value: string): boolean {
  const m = /^(\d{4}-\d{2}-\d{2})(T([01]\d|2[0-3]):[0-5]\d)?$/.exec(value);
  return !!m && isDate(m[1] as string);
}

export function parseLine(raw: string): Line {
  const m = ENTRY_RE.exec(raw.trimEnd());
  if (!m) return { raw };
  const entry: Entry = { fields: {}, ext: false, unknown: [], text: "", tags: [] };
  for (const token of (m[1] ?? "").split(/\s+/).filter(Boolean)) {
    const [key, value] = splitField(token);
    if ((ENTRY_TYPES as readonly string[]).includes(token) && !entry.type && !entry.date) {
      entry.type = token as EntryType;
    } else if (isDate(token) && !entry.date) {
      entry.date = token;
    } else if (
      value !== undefined &&
      isDateField(key) &&
      (key === "due" ? isDue(value) : isDate(value))
    ) {
      entry.fields[key] = value;
    } else if (token === "ext") {
      entry.ext = true;
    } else if (key === "topic" && value && isTopic(value) && !entry.topic) {
      entry.topic = value;
    } else {
      entry.unknown.push(token);
    }
  }
  const { text, tags } = splitTags(m[2] ?? "");
  entry.text = text;
  entry.tags = tags;
  return { raw, entry };
}

/** Trailing `#tags` split off a text: "Lives in Osaka #home #大阪" → text and ["home", "大阪"]. */
export function splitTags(input: string): { text: string; tags: string[] } {
  let text = input.trim();
  const tags: string[] = [];
  for (let t = TAG_RE.exec(` ${text}`); t; t = TAG_RE.exec(` ${text}`)) {
    tags.unshift(t[1] as string);
    text = ` ${text}`.slice(0, t.index).trim();
  }
  return { text, tags };
}

export function formatEntry(entry: Entry): string {
  const head = [
    entry.type,
    entry.date,
    ...DATE_FIELDS.flatMap((f) => (entry.fields[f] ? [`${f}:${entry.fields[f]}`] : [])),
    entry.ext ? "ext" : undefined,
    entry.topic ? `topic:${entry.topic}` : undefined,
    ...entry.unknown,
  ].filter(Boolean);
  const tags = entry.tags.map((t) => ` #${t}`).join("");
  return `- ${head.length ? `[${head.join(" ")}] ` : ""}${entry.text}${tags}`;
}

export function parseFile(text: string): Line[] {
  if (text === "") return [];
  return text.replace(/\n$/, "").split("\n").map(parseLine);
}

export function serializeFile(lines: Line[]): string {
  return lines.length ? `${lines.map((l) => l.raw).join("\n")}\n` : "";
}

/** A line for an entry Ivy wrote or changed. */
export function entryLine(entry: Entry): Line {
  return { raw: formatEntry(entry), entry };
}

/** Characters the entries take up: what counts against a file's limit. Headings are free. */
export function usage(lines: Line[]): number {
  return lines.reduce((n, l) => (l.entry ? n + [...l.raw].length + 1 : n), 0);
}

/** Tags as the model may pass them ("#牙医", "dental care") → ["牙医", "dental-care"]. */
export function normalizeTags(tags: string[]): string[] {
  const out = tags
    .map((t) => t.trim().replace(/^#+/, "").replace(/\s+/g, "-").replace(/#/g, ""))
    .filter((t) => /\p{L}/u.test(t));
  return [...new Set(out)];
}

function splitField(token: string): [string, string | undefined] {
  const i = token.indexOf(":");
  return i < 0 ? [token, undefined] : [token.slice(0, i), token.slice(i + 1)];
}

function isDateField(key: string): key is DateField {
  return (DATE_FIELDS as readonly string[]).includes(key);
}

/** "dentist, 牙医、看牙 #health" → ["dentist", "牙医", "看牙", "health"]; undefined stays undefined. */
export function tagList(tags: string | undefined): string[] | undefined {
  return tags === undefined ? undefined : tags.split(/[,，、;；#\n]+/).filter((t) => t.trim());
}

export { localDate } from "@ivy/plugin-api";
