#!/usr/bin/env bun
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runDaemon } from "@ivy/daemon";
import { createIvy, errorMessage, resolvePaths, Session, setLogLevel } from "@ivy/kernel";
import core from "@ivy/plugin-core";
import journal from "@ivy/plugin-journal";
import memory from "@ivy/plugin-memory";
import { render } from "ink";
import { createElement } from "react";
import { assertNoCommandClash } from "./commands.ts";
import { InputHistory } from "./history.ts";
import { PLAIN_INSTRUCTIONS, TUI_INSTRUCTIONS } from "./interface.ts";
import { confirmPlain, runPlain } from "./plain.ts";
import { App, type ConfirmBridge, type Screen } from "./tui/app.tsx";

// Erase screen + scrollback, cursor home.
const CLEAR_TERMINAL = "\x1b[2J\x1b[3J\x1b[H";

const HELP = `Usage: ivy [options] [prompt]

  ivy                 Start the interactive TUI
  ivy "question"      Ask once, print the answer and exit
  ivy -c              Continue the most recent session
  ivy -r [id]         Resume a session (pick from a list without an id)
  ivy daemon          Run Ivy in the background (the menu-bar app starts it)

Options:
  -c, --continue      Continue the most recent session
  -r, --resume [id]   Resume session <id>, or pick one
  -v, --verbose       Show request/response details, hidden context and logs
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
    await runDaemon(resolvePaths());
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
  // In the TUI, stderr logging would corrupt the screen; verbose details are shown inline instead.
  if (verbose && !interactive) setLogLevel("debug");

  const bridge: ConfirmBridge = { confirm: confirmPlain };
  const ivy = await createIvy({
    plugins: [core, memory, journal],
    confirm: (call) => bridge.confirm(call),
    interfaceInstructions: interactive ? TUI_INSTRUCTIONS : PLAIN_INSTRUCTIONS,
  });
  assertNoCommandClash(ivy.plugins.commands().map(({ def }) => def));
  const { sessions } = ivy.paths;

  let session: Session;
  const pickSession = values.resume === "";
  if (values.resume) {
    session = Session.load(sessions, values.resume);
  } else if (values.continue) {
    const last = Session.list(sessions, 1)[0];
    session = last ? Session.load(sessions, last.id) : Session.create(sessions, ivy.agent.model);
  } else {
    session = Session.create(sessions, ivy.agent.model);
  }

  try {
    await ivy.systemPrompt.start(session.id);
    if (!interactive) {
      const result = await runPlain(ivy, session, ivy.tracer(session.id), prompt, verbose);
      return result.stopReason === "error" ? 1 : 0;
    }
    const history = new InputHistory(join(ivy.paths.home, "input_history.jsonl"));
    const screen: Screen = { clear: () => {} };
    const app = render(
      createElement(App, { ivy, session, history, bridge, screen, verbose, pickSession }),
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
  } finally {
    await ivy.plugins.teardown();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`\x1b[31m${errorMessage(err)}\x1b[0m`);
    process.exit(1);
  },
);
