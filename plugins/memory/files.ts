// The three memory files, each a LineFile (linefile.ts). They share one Serial, so a change
// that moves an entry from one file to another reads and writes them as one step.

import { join } from "node:path";
import { LineFile } from "./linefile.ts";
import { FILE_NAMES, FILES, type FileName, type Files } from "./store.ts";
import { Serial } from "./write.ts";

const HEADERS: Record<FileName, string> = {
  user: "# User\nAbout the user and how they like things done. Maintained by Ivy; you can edit it. One entry per line.\n\n",
  memory:
    "# Memory\nFacts, todos and notes in current use. Maintained by Ivy; you can edit it. One entry per line.\n\n",
  archive:
    "# Archive\nEntries no longer in current use, found by searching. `until:` = no longer true, `replaced:` = reworded. Maintained by Ivy; you can edit it.\n\n",
};

export class MemoryFiles {
  private readonly serial = new Serial();
  readonly files: Record<FileName, LineFile>;

  constructor(readonly dir: string) {
    const file = (name: FileName) =>
      new LineFile(join(dir, FILE_NAMES[name]), HEADERS[name], this.serial);
    this.files = { user: file("user"), memory: file("memory"), archive: file("archive") };
  }

  /** The files as they are now; a missing file reads as its header. */
  read(): Files {
    return {
      user: this.files.user.read(),
      memory: this.files.memory.read(),
      archive: this.files.archive.read(),
    };
  }

  /** Read, change and write the files that changed, as one step, one at a time. */
  change<T>(fn: (files: Files) => T & { files?: Files }): Promise<T> {
    return this.serial.run(() => {
      const before = this.read();
      const result = fn(before);
      const after = result.files;
      if (after) for (const name of FILES) this.files[name].write(before[name], after[name]);
      return result;
    });
  }
}
