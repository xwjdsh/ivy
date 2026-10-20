// Build the menu-bar app: bun run build:app  →  app/build/darwin-arm64/Ivy.app
// It builds the ivy binary, ships it inside the app as bin/ivy (the daemon, and the `ivy`
// command the app installs), then packages the app with MyGo. `--install` also copies the
// app to /Applications, replacing an older one (quit it first).
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
// Ad-hoc signed for this Mac; -skip-dmg: no disk image is needed to run it here.
await run(["go", "tool", "mygo", "build", "-skip-dmg", "-skip-notarize"], "app");

const app = "app/build/darwin-arm64/Ivy.app";
if (process.argv.includes("--install")) {
  rmSync("/Applications/Ivy.app", { recursive: true, force: true });
  cpSync(app, "/Applications/Ivy.app", { recursive: true, verbatimSymlinks: true });
  console.log("Installed /Applications/Ivy.app");
} else {
  console.log(`Built ${app}`);
}
