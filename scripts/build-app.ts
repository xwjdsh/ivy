// Build the macOS app: bun run build:app  →  app/build/darwin-arm64/Ivy Dev.app
// It builds the ivy binary, ships it inside the app as bin/ivy (the daemon, and the command
// the app installs), then packages the app with MyGo.
//
// Without flags it is the development app, "Ivy Dev": its own data (~/.ivy-dev), daemon,
// Keychain entries and `ivy-dev` command, so trying a change never touches the user's Ivy
// (DESIGN.md §7). `--install` builds the user's Ivy and copies it to /Applications, replacing
// an older one (quit it first). `--dmg` builds the user's Ivy as a disk image to hand to
// someone else: signed ad hoc, so on their Mac it opens only after Open Anyway in System
// Settings → Privacy & Security.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const run = async (cmd: string[], cwd = ".") => {
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  // Thrown, not exited, so the `finally` below puts mygo.json back.
  if ((await proc.exited) !== 0) throw new Error(`${cmd.join(" ")} failed`);
};

const install = process.argv.includes("--install");
const dmg = process.argv.includes("--dmg");
const release = install || dmg;

await run(["bun", "scripts/build.ts", ...(release ? ["--release"] : [])]);
const bin = "app/resources/darwin-arm64/bin";
mkdirSync(bin, { recursive: true });
cpSync("dist/ivy", join(bin, "ivy"));

// The development app is MyGo's configuration renamed for the build, as `mygo dev` names its
// own: "<name> Dev", "<identifier>.dev".
const configFile = "app/mygo.json";
const config = readFileSync(configFile, "utf8");
const name = release ? "Ivy" : "Ivy Dev";
if (!release) {
  const c = JSON.parse(config) as { name: string; identifier: string };
  writeFileSync(
    configFile,
    `${JSON.stringify({ ...c, name, identifier: `${c.identifier}.dev` }, null, 2)}\n`,
  );
}
try {
  // Ad-hoc signed; no disk image unless asked for, as none is needed to run it here.
  await run(
    ["go", "tool", "mygo", "build", ...(dmg ? [] : ["-skip-dmg"]), "-skip-notarize"],
    "app",
  );
} finally {
  writeFileSync(configFile, config);
}

const app = `app/build/darwin-arm64/${name}.app`;
if (install) {
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
