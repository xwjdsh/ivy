// Which code a process runs, so a client can tell a daemon running older code than its
// own (an `ivy` updated, or source edited in development) and replace it.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Set when `bun run build` compiles ivy: the commit and the time of the build. */
declare const IVY_BUILD: string | undefined;

/** The repository root, from this file (packages/daemon/src). */
const ROOT = join(import.meta.dir, "..", "..", "..");
/** Where the code that runs lives: the packages and plugins, not tests or evals. */
const SOURCES = ["packages", "plugins"];

let cached: string | undefined;

/**
 * A compiled ivy's build id; from source, a fingerprint of the source files (their paths,
 * sizes and times), so an edit gives a new one. Computed once per process.
 */
export function codeVersion(): string {
  cached ??= typeof IVY_BUILD === "string" ? IVY_BUILD : `dev-${sourceFingerprint()}`;
  return cached;
}

function sourceFingerprint(): string {
  const hash = new Bun.CryptoHasher("sha1");
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const path = join(dir, name);
      const stat = statSync(path, { throwIfNoEntry: false });
      if (!stat) continue;
      if (stat.isDirectory()) walk(path);
      else if (/\.(ts|tsx|md|json)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
        hash.update(`${path}:${stat.size}:${stat.mtimeMs}\n`);
      }
    }
  };
  for (const dir of SOURCES) walk(join(ROOT, dir));
  return hash.digest("hex").slice(0, 12);
}
