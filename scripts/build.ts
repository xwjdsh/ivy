// Build a single `ivy` binary: bun run build  →  dist/ivy
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

const result = await Bun.build({
  entrypoints: ["packages/cli/src/main.ts"],
  compile: { outfile: "dist/ivy" },
  minify: true,
  plugins: [stubDevtools],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log("Built dist/ivy");
