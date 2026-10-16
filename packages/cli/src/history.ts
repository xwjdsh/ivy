import { appendFileSync, existsSync, readFileSync } from "node:fs";

const MAX_ENTRIES = 500;

/** Input history, persisted as one JSON string per line so multi-line inputs survive. */
export class InputHistory {
  readonly entries: string[];

  constructor(private readonly file: string) {
    this.entries = existsSync(file)
      ? readFileSync(file, "utf8")
          .split("\n")
          .filter(Boolean)
          .flatMap((line) => {
            try {
              return [JSON.parse(line) as string];
            } catch {
              return [];
            }
          })
          .slice(-MAX_ENTRIES)
      : [];
  }

  add(entry: string): void {
    if (!entry.trim() || this.entries.at(-1) === entry) return;
    this.entries.push(entry);
    try {
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
    } catch {
      // History is a convenience; never fail a turn because of it.
    }
  }
}
