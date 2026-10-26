// The memory files: the two hot files, each a LineFile (linefile.ts), and the archive, a
// file per topic under archive/. They share one Serial, so a change that moves an entry
// from one file to another reads and writes them as one step.
//
// The archive reads as one list of lines, each entry's `topic` set to its file's; written
// back, each topic's entries go to its file, without the `topic:` the file already says, a
// topic's file is made when it gets its first entry and removed with its last (not
// `general`'s). A topic's file starts with its title and when it matters:
//
//   # Family · 家人
//   When it matters: the user's parents and sister Lin, visits home, relatives' health.

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { formatEntry, isTopic, type Line, parseFile, serializeFile } from "./format.ts";
import { LineFile } from "./linefile.ts";
import { FILE_NAMES, type Files, GENERAL, GENERAL_TOPIC, type Topic, topicOf } from "./store.ts";
import { Serial, writeAtomic } from "./write.ts";

const HEADERS = {
  user: "# User\nAbout the user and how they like things done. Maintained by Ivy; you can edit it. One entry per line.\n\n",
  memory:
    "# Memory\nFacts, todos and notes in current use. Maintained by Ivy; you can edit it. One entry per line.\n\n",
};
const ABOUT_PREFIX = "When it matters:";

export class MemoryFiles {
  private readonly serial = new Serial();
  /** The topic file each line that isn't an entry was read from: written back there. */
  private readonly origin = new WeakMap<Line, string>();
  readonly files: Record<"user" | "memory", LineFile>;
  readonly archiveDir: string;

  constructor(readonly dir: string) {
    const file = (name: "user" | "memory") =>
      new LineFile(join(dir, FILE_NAMES[name]), HEADERS[name], this.serial);
    this.files = { user: file("user"), memory: file("memory") };
    this.archiveDir = join(dir, "archive");
  }

  /** The files as they are now; a missing file reads as its header. */
  read(): Files {
    const { lines, topics } = this.readArchive();
    return {
      user: this.files.user.read(),
      memory: this.files.memory.read(),
      archive: lines,
      topics,
    };
  }

  /** Read, change and write the files that changed, as one step, one at a time. */
  change<T>(fn: (files: Files) => T & { files?: Files }): Promise<T> {
    return this.serial.run(() => {
      const before = this.read();
      const result = fn(before);
      const after = result.files;
      if (after) {
        this.files.user.write(before.user, after.user);
        this.files.memory.write(before.memory, after.memory);
        this.writeArchive(after);
      }
      return result;
    });
  }

  /** A topic's file as it is, for reading whole. */
  topicFile(name: string): string {
    return join(this.archiveDir, `${name}.md`);
  }

  private readArchive(): { lines: Line[]; topics: Record<string, Topic> } {
    const topics: Record<string, Topic> = { [GENERAL]: GENERAL_TOPIC };
    const lines: Line[] = [];
    if (!existsSync(this.archiveDir)) return { lines, topics };
    for (const f of readdirSync(this.archiveDir).sort()) {
      const name = f.replace(/\.md$/, "");
      if (!f.endsWith(".md") || !isTopic(name)) continue;
      const read = parseTopicFile(readFileSync(join(this.archiveDir, f), "utf8"), name);
      topics[name] = read.topic;
      for (const line of read.lines) {
        // General's entries carry no topic: it is where an entry without one goes.
        const topic = name === GENERAL ? undefined : name;
        if (!line.entry) this.origin.set(line, name);
        lines.push(line.entry ? { ...line, entry: { ...line.entry, topic } } : line);
      }
    }
    return { lines, topics };
  }

  private writeArchive(files: Files): void {
    const byTopic = new Map<string, Line[]>();
    for (const line of files.archive) {
      // A hand-written line stays in its file; an entry whose topic is gone (a hot entry
      // named it, and it emptied since) goes to general rather than make it again unasked.
      const name = line.entry
        ? files.topics[topicOf(line)]
          ? topicOf(line)
          : GENERAL
        : (this.origin.get(line) ?? GENERAL);
      const list = byTopic.get(name) ?? [];
      list.push(onDisk(line));
      byTopic.set(name, list);
    }
    const names = new Set([...Object.keys(files.topics), ...byTopic.keys()]);
    for (const name of names) {
      const path = this.topicFile(name);
      const lines = byTopic.get(name) ?? [];
      if (lines.length === 0 && name !== GENERAL) {
        rmSync(path, { force: true });
        continue;
      }
      const topic = files.topics[name] ?? GENERAL_TOPIC;
      const text = topicHeader(topic) + serializeFile(lines);
      const now = existsSync(path) ? readFileSync(path, "utf8") : undefined;
      if (text !== now) writeAtomic(path, text);
    }
  }
}

function topicHeader(topic: Topic): string {
  return `# ${topic.title}\n${ABOUT_PREFIX} ${topic.about}\n\n`;
}

/** A topic's file: its title and when it matters from the header, then its lines. */
function parseTopicFile(text: string, name: string): { topic: Topic; lines: Line[] } {
  const lines = parseFile(text);
  let title = name === GENERAL ? GENERAL_TOPIC.title : name;
  let about = name === GENERAL ? GENERAL_TOPIC.about : "";
  let i = 0;
  const first = lines[0]?.raw ?? "";
  if (first.startsWith("# ")) {
    // General's title is fixed, as its name and meaning are, whatever its file says.
    if (name !== GENERAL) title = first.slice(2).trim() || title;
    i = 1;
  }
  const second = lines[i]?.raw ?? "";
  if (second.startsWith(ABOUT_PREFIX)) {
    about = second.slice(ABOUT_PREFIX.length).trim();
    i++;
  }
  while (i < lines.length && !lines[i]?.raw.trim()) i++;
  return { topic: { title, about }, lines: lines.slice(i) };
}

/** A line as its topic's file has it: the file says the topic, the line needn't. */
function onDisk(line: Line): Line {
  const e = line.entry;
  // Only a topic: among the bracketed fields, not "the topic: budget" in the words.
  if (!e || !/^\s*- \[[^\]]*\btopic:/.test(line.raw)) return line;
  return { raw: formatEntry({ ...e, topic: undefined }), entry: e };
}
