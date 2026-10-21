#!/usr/bin/env bun
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runDaemon } from "@ivy/daemon";
import { errorMessage, resolvePaths } from "@ivy/kernel";
import core from "@ivy/plugin-core";
import journal from "@ivy/plugin-journal";
import memory from "@ivy/plugin-memory";
import { render } from "ink";
import { createElement } from "react";
import { connect } from "./client.ts";
import { assertNoCommandClash } from "./commands.ts";
import { InputHistory } from "./history.ts";
import { runPlain } from "./plain.ts";
import { App, type Screen } from "./tui/app.tsx";

// Erase screen + scrollback, cursor home.
const CLEAR_TERMINAL = "\x1b[2J\x1b[3J\x1b[H";

const HELP = `Usage: ivy [options] [prompt]

  ivy                 Start the interactive TUI
  ivy "question"      Ask once, print the answer and exit
  ivy -c              Continue the most recent session
  ivy -r [id]         Resume a session (pick from a list without an id)
  ivy daemon          Run Ivy in the background (the app starts it)

Options:
  -c, --continue      Continue the most recent session
  -r, --resume [id]   Resume session <id>, or pick one
  -v, --verbose       Show request/response details and hidden context
  -h, --help          Show this help`;

/** parseArgs has no optional option values; a bare -r/--resume becomes "" (= open the picker). */
function withOptionalResumeValue(argv: string[]): string[] {
  return argv.flatMap((arg, i) => {
    const bare = arg === "-r" || arg === "--resume";
    const next = argv[i + 1];
    return bare && (next === undefined || next.startsWith("-")) ? [arg, ""] : [arg];
  });
}

async function main(): Promise<number> {
  if (process.argv[2] === "daemon") {
    // `--idle-exit <ms>`: started on demand by `ivy`, so it exits once unused.
    const { values } = parseArgs({
      args: process.argv.slice(3),
      options: { "idle-exit": { type: "string" } },
    });
    const idleExitMs = values["idle-exit"] ? Number(values["idle-exit"]) : undefined;
    await runDaemon(resolvePaths(), [core, memory, journal], { idleExitMs });
    return 0;
  }
  const { values, positionals } = parseArgs({
    args: withOptionalResumeValue(process.argv.slice(2)),
    allowPositionals: true,
    options: {
      continue: { type: "boolean", short: "c" },
      resume: { type: "string", short: "r" },
      verbose: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const verbose = values.verbose ?? false;
  const prompt = positionals.join(" ").trim();
  const interactive = prompt === "";

  if (interactive && !process.stdin.isTTY) {
    console.error('Interactive mode needs a terminal. Pass a prompt instead: ivy "question"');
    return 1;
  }

  // Ivy runs in the daemon; this process only shows it (DESIGN.md §5.7).
  const paths = resolvePaths();
  const client = await connect(paths);

  let sessionId: string;
  const pickSession = values.resume === "";
  if (values.resume) {
    sessionId = values.resume;
  } else if (values.continue) {
    const last = (await client.sessions())[0];
    sessionId = last ? last.id : await client.createSession();
  } else {
    sessionId = await client.createSession(interactive ? "markdown" : "plain");
  }

  if (!interactive) {
    const end = await runPlain(client, sessionId, prompt, verbose);
    return end.stopReason === "error" ? 1 : 0;
  }
  const [session, state, pluginCommands] = await Promise.all([
    client.session(sessionId),
    client.state(),
    client.commands(),
  ]);
  assertNoCommandClash(pluginCommands);
  const history = new InputHistory(join(paths.home, "input_history.jsonl"));
  const screen: Screen = { clear: () => {} };
  const app = render(
    createElement(App, {
      client,
      session,
      state,
      pluginCommands,
      history,
      screen,
      verbose,
      pickSession,
    }),
    {
      exitOnCtrlC: false,
      kittyKeyboard: { mode: "auto" },
    },
  );
  // Ink forgets its last frame on clear(), so the next render redraws everything.
  screen.clear = () => {
    app.clear();
    process.stdout.write(CLEAR_TERMINAL);
  };
  await app.waitUntilExit();
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`\x1b[31m${errorMessage(err)}\x1b[0m`);
    process.exit(1);
  },
);
