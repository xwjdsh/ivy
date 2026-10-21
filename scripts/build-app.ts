// Build the macOS app: bun run build:app  →  app/build/darwin-arm64/Ivy.app
// It builds the ivy binary, ships it inside the app as bin/ivy (the daemon, and the `ivy`
// command the app installs), then packages the app with MyGo. `--install` also copies the
// app to /Applications, replacing an older one (quit it first). `--dmg` also makes the disk
// image to hand to someone else: signed ad hoc, so on their Mac it opens only after Open
// Anyway in System Settings → Privacy & Security.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const run = async (cmd: string[], cwd = ".") => {
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) process.exit(1);
};

await run(["bun", "scripts/build.ts"]);
const bin = "app/resources/darwin-arm64/bin";
mkdirSync(bin, { recursive: true });
cpSync("dist/ivy", join(bin, "ivy"));
// Ad-hoc signed; no disk image unless asked for, as none is needed to run it here.
const dmg = process.argv.includes("--dmg");
await run(["go", "tool", "mygo", "build", ...(dmg ? [] : ["-skip-dmg"]), "-skip-notarize"], "app");

const app = "app/build/darwin-arm64/Ivy.app";
if (process.argv.includes("--install")) {
  rmSync("/Applications/Ivy.app", { recursive: true, force: true });
  cpSync(app, "/Applications/Ivy.app", { recursive: true, verbatimSymlinks: true });
  console.log("Installed /Applications/Ivy.app");
} else {
  console.log(`Built ${app}`);
}
if (dmg) {
  const image = new Bun.Glob("app/build/darwin-arm64/*.dmg").scanSync().next().value;
  console.log(`Built ${image}`);
}
