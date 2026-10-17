// Reading and writing the three memory files. They are read fresh on every call (they are
// small), so hand edits apply at once, and written atomically (temp file + rename). One
// lock serializes changes within the process: a model may call several memory tools in
// one step, and they run in parallel.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFile, serializeFile } from "./format.ts";
import { FILE_NAMES, FILES, type FileName, type Files } from "./store.ts";

const HEADERS: Record<FileName, string> = {
  user: "# User\nAbout the user and how they like things done. Maintained by Ivy; you can edit it. One entry per line.\n\n",
  memory:
    "# Memory\nFacts, todos and notes in current use. Maintained by Ivy; you can edit it. One entry per line.\n\n",
  archive:
    "# Archive\nEntries no longer in current use, found by searching. `until:` = no longer true, `replaced:` = reworded. Maintained by Ivy; you can edit it.\n\n",
};

export class MemoryFiles {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly dir: string) {}

  private path(file: FileName): string {
    return join(this.dir, FILE_NAMES[file]);
  }

  /** The files as they are now; a missing file reads as its header. */
  read(): Files {
    const files = {} as Files;
    for (const file of FILES) {
      const path = this.path(file);
      files[file] = parseFile(existsSync(path) ? readFileSync(path, "utf8") : HEADERS[file]);
    }
    return files;
  }

  /** Write the files that changed (by content), atomically. */
  write(before: Files, after: Files): void {
    mkdirSync(this.dir, { recursive: true });
    for (const file of FILES) {
      const text = serializeFile(after[file]);
      if (text === serializeFile(before[file]) && existsSync(this.path(file))) continue;
      const tmp = `${this.path(file)}.tmp`;
      writeFileSync(tmp, text);
      renameSync(tmp, this.path(file));
    }
  }

  /** Read, change and write as one step, one at a time. */
  change<T>(fn: (files: Files) => T & { files?: Files }): Promise<T> {
    const run = this.queue.then(() => {
      const before = this.read();
      const result = fn(before);
      if (result.files) this.write(before, result.files);
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

/** The file's text without Ivy's header, for the prompt. Hand-written lines stay. */
export function body(file: FileName, text: string): string {
  return (text.startsWith(HEADERS[file]) ? text.slice(HEADERS[file].length) : text).trim();
}
