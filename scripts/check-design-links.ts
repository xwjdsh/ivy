// Check that what the code cites of the design is there: `docs/design/<file>.md#<heading>`
// names a file and one of its headings, and `DESIGN.md §<n>` a section of DESIGN.md. Run by
// `bun run lint`, so a citation goes stale in the commit that moves what it points to.
import { existsSync, readFileSync } from "node:fs";

/** GitHub's anchor for a heading: lower case, punctuation dropped, spaces as hyphens. */
const anchor = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");

/** A Markdown file's headings, as anchors and as their section numbers ("5.2.1"). */
function headings(file: string) {
  const anchors = new Set<string>();
  const numbers = new Set<string>();
  let fence = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.startsWith("```")) fence = !fence;
    const m = fence ? null : /^#+ (.*)$/.exec(line);
    if (!m?.[1]) continue;
    anchors.add(anchor(m[1]));
    const n = /^(\d+(?:\.\d+)*)\.? /.exec(m[1]);
    if (n?.[1]) numbers.add(n[1]);
  }
  return { anchors, numbers };
}

const files = (await Bun.$`git ls-files -co --exclude-standard`.quiet().text())
  .split("\n")
  .filter((f) => /\.(ts|tsx|go|md)$/.test(f) && existsSync(f));
const design = headings("docs/DESIGN.md");
const known = new Map<string, ReturnType<typeof headings>>();
const problems: string[] = [];

for (const file of files) {
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      const at = `${file}:${i + 1}`;
      for (const m of line.matchAll(/docs\/design\/([\w-]+\.md)(?:#([\w-]+))?/g)) {
        const target = `docs/design/${m[1]}`;
        if (!existsSync(target)) {
          problems.push(`${at}: no ${target}`);
          continue;
        }
        if (!known.has(target)) known.set(target, headings(target));
        if (m[2] && !known.get(target)?.anchors.has(m[2])) {
          problems.push(`${at}: no heading #${m[2]} in ${target}`);
        }
      }
      // "DESIGN.md §5.4, §11 M3": every number after it.
      for (const m of line.matchAll(/DESIGN\.md ?((?:§\d+(?:\.\d+)*(?:,? ?M\d)?,? ?)+)/g)) {
        for (const n of m[1]?.matchAll(/§(\d+(?:\.\d+)*)/g) ?? []) {
          if (n[1] && !design.numbers.has(n[1])) problems.push(`${at}: no §${n[1]} in DESIGN.md`);
        }
      }
    });
}

if (problems.length > 0) {
  console.error(`Design citations that point nowhere:\n${problems.join("\n")}`);
  process.exit(1);
}
