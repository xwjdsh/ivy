#!/usr/bin/env bun
import { createInterface, type Interface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  type AgentEvent,
  createIvy,
  type Ivy,
  Session,
  setLogLevel,
  type ToolCallRequest,
  Tracer,
  type TurnResult,
} from "@ivy/kernel";
import core from "@ivy/plugin-core";

const HELP = `Usage: ivy [options] [prompt]

  ivy                 Start an interactive chat
  ivy "question"      Ask once and exit
  ivy -c              Continue the most recent session
  ivy -r <id>         Resume a specific session

Options:
  -c, --continue      Continue the most recent session
  -r, --resume <id>   Resume session <id>
  -d, --debug         Show per-step tokens, cost, latency and trace files
  -h, --help          Show this help

Commands (interactive):
  /new                Start a new session
  /sessions           List recent sessions
  /resume <id>        Switch to another session
  /help               Show commands
  /exit               Quit (or Ctrl-D)`;

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

class Cli {
  private session!: Session;
  private tracer!: Tracer;
  private turnAbort: AbortController | null = null;
  private atLineStart = true;

  constructor(
    private readonly ivy: Ivy,
    private readonly rl: Interface,
    private readonly debug: boolean,
  ) {
    rl.on("SIGINT", () => {
      if (this.turnAbort) {
        this.turnAbort.abort();
      } else {
        this.rl.close();
      }
    });
  }

  useSession(session: Session): void {
    this.session = session;
    this.tracer = new Tracer(`${this.ivy.paths.traces}/${session.id}`);
  }

  newSession(): void {
    this.useSession(Session.create(this.ivy.paths.sessions, this.ivy.config.model.name));
  }

  async repl(): Promise<void> {
    const toolCount = this.ivy.plugins.apiTools().length;
    console.log(
      c.dim(
        `Ivy · ${this.ivy.config.model.name} · ${this.ivy.plugins.list().length} plugins, ${toolCount} tools · session ${this.session.id}`,
      ),
    );
    console.log(c.dim("Type /help for commands. Ctrl-C interrupts, Ctrl-D exits.\n"));

    let closed = false;
    this.rl.once("close", () => {
      closed = true;
    });

    while (!closed) {
      let line: string;
      try {
        line = (await this.rl.question(c.bold("› "))).trim();
      } catch {
        break; // readline closed (Ctrl-D / Ctrl-C at the prompt)
      }
      if (!line) continue;
      if (line.startsWith("/")) {
        if (!this.command(line)) break;
        continue;
      }
      await this.turn(line);
      console.log();
    }
  }

  /** Handle a slash command. Returns false to quit. */
  private command(line: string): boolean {
    const [cmd, ...args] = line.split(/\s+/);
    switch (cmd) {
      case "/exit":
      case "/quit":
        return false;
      case "/help":
        console.log(HELP.slice(HELP.indexOf("Commands")));
        break;
      case "/new":
        this.newSession();
        console.log(c.dim(`New session ${this.session.id}`));
        break;
      case "/sessions":
        this.printSessions();
        break;
      case "/resume": {
        const id = args[0];
        if (!id) {
          this.printSessions();
          break;
        }
        try {
          this.useSession(Session.load(this.ivy.paths.sessions, id));
          console.log(c.dim(`Resumed ${id} (${this.session.messages.length} messages)`));
        } catch (err) {
          console.log(c.red(String(err instanceof Error ? err.message : err)));
        }
        break;
      }
      default:
        console.log(c.red(`Unknown command ${cmd}. Try /help.`));
    }
    return true;
  }

  private printSessions(): void {
    const sessions = Session.list(this.ivy.paths.sessions);
    if (sessions.length === 0) {
      console.log(c.dim("No sessions yet."));
      return;
    }
    for (const s of sessions) {
      const mark = s.id === this.session.id ? "*" : " ";
      console.log(`${mark} ${c.cyan(s.id)}  ${c.dim(s.preview || "(empty)")}`);
    }
  }

  async turn(text: string): Promise<TurnResult> {
    this.turnAbort = new AbortController();
    this.atLineStart = true;
    try {
      const result = await this.ivy.agent.runTurn(this.session, text, {
        signal: this.turnAbort.signal,
        onEvent: (e) => this.render(e),
        tracer: this.tracer,
      });
      this.finish(result);
      return result;
    } finally {
      this.turnAbort = null;
    }
  }

  private write(s: string): void {
    process.stdout.write(s);
    if (s.length > 0) this.atLineStart = s.endsWith("\n");
  }

  private newline(): void {
    if (!this.atLineStart) this.write("\n");
  }

  private render(e: AgentEvent): void {
    switch (e.type) {
      case "text":
        this.write(e.delta);
        break;
      case "tool_call":
        this.newline();
        this.write(`${c.cyan("⏺")} ${e.name} ${c.dim(truncate(JSON.stringify(e.input), 120))}\n`);
        break;
      case "tool_result": {
        const body = truncate(e.content.replace(/\s+/g, " "), this.debug ? 400 : 120);
        this.write(`  ${e.isError ? c.red("✗") : c.dim("⎿")} ${c.dim(body)}\n`);
        break;
      }
      case "step":
        if (this.debug) {
          const u = e.usage;
          const cost = e.costUsd === null ? "?" : `$${e.costUsd.toFixed(4)}`;
          this.newline();
          process.stderr.write(
            c.dim(
              `[step ${e.step}] stop=${e.stopReason} in=${u.input_tokens} out=${u.output_tokens} ` +
                `cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0} ` +
                `${cost} ${(e.latencyMs / 1000).toFixed(1)}s\n` +
                (e.traceFile ? `         trace: ${e.traceFile}\n` : ""),
            ),
          );
        }
        break;
    }
  }

  private finish(result: TurnResult): void {
    this.newline();
    const notes: Record<string, string> = {
      interrupted: c.yellow("[interrupted]"),
      refusal: c.yellow("[the model declined this request]"),
      max_steps: c.yellow(`[stopped after ${result.steps} steps]`),
      max_tokens: c.yellow("[response hit max_tokens]"),
      error: c.red(`[error] ${result.error ?? ""}`),
    };
    const note = notes[result.stopReason];
    if (note) console.log(note);
    console.log(c.dim(`$${result.costUsd.toFixed(4)} · ${result.steps} step(s)`));
  }
}

async function confirmWith(rl: Interface, call: ToolCallRequest): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const answer = await rl.question(
    `${c.yellow("?")} Allow ${c.bold(call.name)} (${call.risk})? ${c.dim(JSON.stringify(call.input))} [y/N] `,
  );
  return /^y(es)?$/i.test(answer.trim());
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
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
  if (values.debug) setLogLevel("debug");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY,
  });
  const ivy = await createIvy({ plugins: [core], confirm: (call) => confirmWith(rl, call) });
  const cli = new Cli(ivy, rl, values.debug ?? false);

  if (values.resume) {
    cli.useSession(Session.load(ivy.paths.sessions, values.resume));
  } else if (values.continue) {
    const last = Session.list(ivy.paths.sessions, 1)[0];
    if (last) cli.useSession(Session.load(ivy.paths.sessions, last.id));
    else cli.newSession();
  } else {
    cli.newSession();
  }

  try {
    const prompt = positionals.join(" ").trim();
    if (prompt) {
      const result = await cli.turn(prompt);
      return result.stopReason === "error" ? 1 : 0;
    }
    await cli.repl();
    return 0;
  } finally {
    rl.close();
    await ivy.plugins.teardown();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(c.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  },
);
