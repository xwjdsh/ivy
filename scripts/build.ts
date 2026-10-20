// Build a single `ivy` binary: bun run build  →  dist/ivy
import { unlinkSync } from "node:fs";
import type { BunPlugin } from "bun";

// Ink only loads React DevTools when DEV=true, but the bundler still needs the
// optional `react-devtools-core` package to resolve. Swap in an empty module.
const stubDevtools: BunPlugin = {
  name: "stub-react-devtools",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: "react-devtools-core",
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export default {};",
      loader: "js",
    }));
  },
};

// Which code this binary runs (see codeVersion): a daemon started by an older ivy is
// replaced. The commit, marked when there are uncommitted changes, and the build time.
const commit = (await Bun.$`git rev-parse --short HEAD`.quiet().nothrow()).text().trim();
const dirty = (await Bun.$`git status --porcelain`.quiet().nothrow()).text().trim() !== "";
const build = `${commit || "unknown"}${dirty ? "+" : ""}-${Date.now().toString(36)}`;

const result = await Bun.build({
  entrypoints: ["packages/cli/src/main.ts"],
  compile: { outfile: "dist/ivy" },
  minify: true,
  plugins: [stubDevtools],
  define: { IVY_BUILD: JSON.stringify(build) },
});

// Bun (1.4.3) leaves the executable's temporary copy, about 70 MB, in the working
// directory after every compile (".<hex>-00000000.bun-build"); remove it.
for (const leftover of new Bun.Glob(".*-00000000.bun-build").scanSync({ dot: true })) {
  unlinkSync(leftover);
}

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log("Built dist/ivy");
