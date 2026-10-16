#!/usr/bin/env bun
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createIvy, Session, setLogLevel, Tracer } from "@ivy/kernel";
import core from "@ivy/plugin-core";
import { render } from "ink";
import { createElement } from "react";
import { InputHistory } from "./history.ts";
import { confirmPlain, runPlain } from "./plain.ts";
import { App, type ConfirmBridge, type Screen } from "./tui/app.tsx";

// Erase screen + scrollback, cursor home.
const CLEAR_TERMINAL = "\x1b[2J\x1b[3J\x1b[H";

const HELP = `Usage: ivy [options] [prompt]

  ivy                 Start the interactive TUI
  ivy "question"      Ask once, print the answer and exit
  ivy -c              Continue the most recent session
  ivy -r [id]         Resume a session (pick from a list without an id)

Options:
  -c, --continue      Continue the most recent session
  -r, --resume [id]   Resume session <id>, or pick one
  -d, --debug         Show per-step tokens, cost, latency and trace files
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
  const { values, positionals } = parseArgs({
    args: withOptionalResumeValue(process.argv.slice(2)),
    allowPositionals: true,
    options: {
      continue: { type: "boolean", short: "c" },
      resume: { type: "string", short: "r" },
      debug: { type: "boolean", short: "d" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const debug = values.debug ?? false;
  const prompt = positionals.join(" ").trim();
  const interactive = prompt === "";

  if (interactive && !process.stdin.isTTY) {
    console.error('Interactive mode needs a terminal. Pass a prompt instead: ivy "question"');
    return 1;
  }
  // In the TUI, stderr logging would corrupt the screen; debug info is shown inline instead.
  if (debug && !interactive) setLogLevel("debug");

  const bridge: ConfirmBridge = { confirm: confirmPlain };
  const ivy = await createIvy({ plugins: [core], confirm: (call) => bridge.confirm(call) });
  const { sessions } = ivy.paths;

  let session: Session;
  const pickSession = values.resume === "";
  if (values.resume) {
    session = Session.load(sessions, values.resume);
  } else if (values.continue) {
    const last = Session.list(sessions, 1)[0];
    session = last
      ? Session.load(sessions, last.id)
      : Session.create(sessions, ivy.config.model.name);
  } else {
    session = Session.create(sessions, ivy.config.model.name);
  }

  try {
    if (!interactive) {
      const tracer = new Tracer(join(ivy.paths.traces, session.id));
      const result = await runPlain(ivy, session, tracer, prompt, debug);
      return result.stopReason === "error" ? 1 : 0;
    }
    const history = new InputHistory(join(ivy.paths.home, "input_history.jsonl"));
    const screen: Screen = { clear: () => {} };
    const app = render(
      createElement(App, { ivy, session, history, bridge, screen, debug, pickSession }),
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
    console.error(`\x1b[31m${err instanceof Error ? err.message : String(err)}\x1b[0m`);
    process.exit(1);
  },
);
