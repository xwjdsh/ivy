// One file of entry lines under Ivy's header (memory's three files, the journal's IVY.md).
// It is read fresh on every call (it is small), so hand edits apply at once, and written
// whole and atomically. Changes run one at a time: a model may call several write tools in
// one step, and they run in parallel. Files that change together share one Serial.

import { existsSync, readFileSync } from "node:fs";
import { type Line, parseFile, serializeFile } from "./format.ts";
import { Serial, writeAtomic } from "./write.ts";

export class LineFile {
  constructor(
    readonly path: string,
    /** Ivy's header: what the file is and who writes it; a missing file reads as this. */
    readonly header: string,
    /** Shared by files that change together, so one change sees and writes all of them. */
    readonly serial = new Serial(),
  ) {}

  read(): Line[] {
    return parseFile(existsSync(this.path) ? readFileSync(this.path, "utf8") : this.header);
  }

  /** Write the lines unless they are what the file already holds. */
  write(before: Line[], after: Line[]): void {
    const text = serializeFile(after);
    if (text === serializeFile(before) && existsSync(this.path)) return;
    writeAtomic(this.path, text);
  }

  /** Read, change and write as one step, after the changes before it. */
  change<T>(fn: (lines: Line[]) => T & { lines?: Line[] }): Promise<T> {
    return this.serial.run(() => {
      const before = this.read();
      const result = fn(before);
      if (result.lines) this.write(before, result.lines);
      return result;
    });
  }

  /** The lines without Ivy's header, for the prompt. Hand-written lines stay. */
  body(lines: Line[]): string {
    const text = serializeFile(lines);
    return (text.startsWith(this.header) ? text.slice(this.header.length) : text).trim();
  }
}
