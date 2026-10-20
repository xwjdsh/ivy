import { createInterface } from "node:readline/promises";
import type { RequestInfo } from "@ivy/kernel";
import type {
  PermissionAnswer,
  PermissionAsk,
  SessionEvent,
  ToolLabel,
  TurnEnd,
} from "@ivy/protocol";
import type { DaemonClient } from "./client.ts";
import { formatCall } from "./verbose-format.ts";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

/** Why a turn's result never came: the connection dropped while it ran. */
const LOST = "Lost the connection to Ivy's daemon; the reply's end wasn't received";

/** A tool call in one line, as the TUI shows it: "memory · save: Dentist on Friday". */
const label = (l: ToolLabel) => (l.text ? `${c.bold(l.plugin)} · ${l.text}` : c.bold(l.plugin));

/** Asks on the terminal when there is one; without a TTY (scripts, pipes) risky tools are denied. */
async function confirmPlain(ask: PermissionAsk): Promise<PermissionAnswer> {
  if (!process.stdin.isTTY) return "deny";
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(
      `${c.yellow("?")} Allow ${label(ask.label)} (${ask.risk}; ${ask.reason})? ${c.dim(JSON.stringify(ask.input))} [y/N] `,
    );
    return /^y(es)?$/i.test(answer.trim()) ? "once" : "deny";
  } finally {
    rl.close();
  }
}

/**
 * One-shot mode: send the prompt to the daemon and stream the reply as plain text to
 * stdout, diagnostics to stderr, until its turn ends. Ctrl-C interrupts it.
 */
export async function runPlain(
  client: DaemonClient,
  sessionId: string,
  prompt: string,
  verbose: boolean,
): Promise<TurnEnd> {
  let atLineStart = true;
  const write = (s: string) => {
    process.stdout.write(s);
    if (s) atLineStart = s.endsWith("\n");
  };
  const newline = () => {
    if (!atLineStart) write("\n");
  };

  const stop = new AbortController();
  let promptId: string | undefined;
  let lastRequest: RequestInfo | undefined;
  let finish: (end: TurnEnd) => void = () => {};
  const ended = new Promise<TurnEnd>((resolve) => {
    finish = resolve;
  });
  // Turns that ended, by prompt: a turn that fails at once can end before `send` returns
  // the prompt's id, as events come over another connection.
  const endedTurns = new Map<string, TurnEnd>();

  const render = (e: SessionEvent) => {
    if (e.sessionId !== sessionId) return;
    switch (e.type) {
      case "text":
        write(e.delta);
        break;
      case "tool_call":
        newline();
        process.stderr.write(`${c.cyan("⏺")} ${label(e.label)}\n`);
        if (verbose) process.stderr.write(c.dim(`  ${JSON.stringify(e.input)}\n`));
        break;
      case "tool_result":
        process.stderr.write(
          `  ${e.isError ? c.red("✗") : c.dim("⎿")} ${c.dim(e.content.replace(/\s+/g, " ").slice(0, 200))}\n`,
        );
        break;
      case "notice":
        newline();
        process.stderr.write(c.yellow(`${e.text}\n`));
        break;
      case "context":
        if (verbose) {
          newline();
          process.stderr.write(c.dim(`context:\n${e.text}\n`));
        }
        break;
      case "request":
        lastRequest = e.info;
        break;
      case "step":
        if (verbose) {
          newline();
          process.stderr.write(c.dim(`${formatCall(e, lastRequest)}\n`));
        }
        break;
      case "permission":
        newline();
        void confirmPlain(e.ask).then((choice) => client.answer(e.ask.id, choice).catch(() => {}));
        break;
      case "turn_end":
        endedTurns.set(e.promptId, e.end);
        if (e.promptId === promptId) finish(e.end);
        break;
    }
  };

  // Subscribe before sending, so no event of the turn is missed.
  let connected: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    connected = resolve;
  });
  /**
   * After the stream dropped and came back, events may have been missed: if the prompt
   * neither runs nor waits any more, its turn ended meanwhile (or went with a daemon that
   * stopped), so stop waiting.
   */
  const checkPrompt = () => {
    const id = promptId;
    if (!id) return; // not sent yet: checked once `send` returns
    void client.session(sessionId).then(
      (view) => {
        if (view.running?.id === id || view.queue.some((p) => p.id === id)) return;
        finish(endedTurns.get(id) ?? { stopReason: "error", steps: 0, costUsd: 0, error: LOST });
      },
      () => finish({ stopReason: "error", steps: 0, costUsd: 0, error: LOST }),
    );
  };
  let connects = 0;
  const following = client.follow(render, stop.signal, () => {
    if (++connects === 1) connected();
    else checkPrompt();
  });
  const onSigint = () => void client.interrupt(sessionId).catch(() => {});
  process.on("SIGINT", onSigint);
  try {
    await ready;
    promptId = (await client.send(sessionId, prompt)).id;
    const already = endedTurns.get(promptId);
    if (already) finish(already);
    else if (connects > 1) checkPrompt(); // reconnected while sending
    const end = await ended;
    newline();
    if (end.stopReason === "error") process.stderr.write(c.red(`[error] ${end.error ?? ""}\n`));
    else if (end.stopReason !== "end_turn") process.stderr.write(c.yellow(`[${end.stopReason}]\n`));
    if (verbose) process.stderr.write(c.dim(`${end.steps} step(s)\n`));
    return end;
  } finally {
    process.off("SIGINT", onSigint);
    stop.abort();
    await following;
  }
}
