import { createInterface } from "node:readline/promises";
import type { AgentEvent, Ivy, Session, ToolCallRequest, Tracer, TurnResult } from "@ivy/kernel";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

/** Asks on the terminal when there is one; without a TTY (scripts, pipes) risky tools are denied. */
export async function confirmPlain(call: ToolCallRequest): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(
      `${c.yellow("?")} Allow ${c.bold(call.name)} (${call.risk})? ${c.dim(JSON.stringify(call.input))} [y/N] `,
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** One-shot mode: stream plain text to stdout, diagnostics to stderr. */
export async function runPlain(
  ivy: Ivy,
  session: Session,
  tracer: Tracer | undefined,
  prompt: string,
  debug: boolean,
): Promise<TurnResult> {
  let atLineStart = true;
  const write = (s: string) => {
    process.stdout.write(s);
    if (s) atLineStart = s.endsWith("\n");
  };
  const newline = () => {
    if (!atLineStart) write("\n");
  };

  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on("SIGINT", onSigint);

  const render = (e: AgentEvent) => {
    switch (e.type) {
      case "text":
        write(e.delta);
        break;
      case "tool_call":
        newline();
        process.stderr.write(`${c.cyan("⏺")} ${e.name} ${c.dim(JSON.stringify(e.input))}\n`);
        break;
      case "tool_result":
        process.stderr.write(
          `  ${e.isError ? c.red("✗") : c.dim("⎿")} ${c.dim(e.content.replace(/\s+/g, " ").slice(0, 200))}\n`,
        );
        break;
      case "step":
        if (debug) {
          const u = e.usage;
          newline();
          process.stderr.write(
            c.dim(
              `[step ${e.step}] stop=${e.stopReason} in=${u.input_tokens} out=${u.output_tokens} ` +
                `cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0} ` +
                `$${(e.costUsd ?? 0).toFixed(4)} ${(e.latencyMs / 1000).toFixed(1)}s\n` +
                (e.traceFile ? `  trace: ${e.traceFile}\n` : ""),
            ),
          );
        }
        break;
    }
  };

  try {
    const result = await ivy.agent.runTurn(session, prompt, {
      signal: controller.signal,
      onEvent: render,
      tracer,
    });
    newline();
    if (result.stopReason === "error")
      process.stderr.write(c.red(`[error] ${result.error ?? ""}\n`));
    else if (result.stopReason !== "end_turn")
      process.stderr.write(c.yellow(`[${result.stopReason}]\n`));
    if (debug)
      process.stderr.write(c.dim(`$${result.costUsd.toFixed(4)} · ${result.steps} step(s)\n`));
    return result;
  } finally {
    process.off("SIGINT", onSigint);
  }
}
