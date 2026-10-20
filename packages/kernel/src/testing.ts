// For tests of what runs on the kernel (the daemon, its clients): a model that answers from
// a script, and builders for the content blocks it answers with. Imported as
// `@ivy/kernel/testing`; nothing outside tests uses it.

import type { ModelClient, ModelMessage, ModelRequest } from "./model.ts";

export type Block = ModelMessage["content"][number];

export const text = (t: string) => ({ type: "text", text: t, citations: null }) as unknown as Block;
export const toolUse = (id: string, name: string, input: unknown = {}) =>
  ({ type: "tool_use", id, name, input }) as unknown as Block;

/** One answer: its blocks, why it stopped (default end_turn), and a gate to hold it back. */
export interface Reply {
  content: Block[];
  stop?: string;
  /** The reply streams its text, then waits for this (a turn that runs a while). */
  gate?: Promise<void>;
}

/** A reply, or one made when the model is called (after waiting, or failing on abort). */
export type Step = Reply | ((signal: AbortSignal) => Promise<Reply>);

/** Answers each call with the next step of its script, and keeps the requests it saw. */
export class ScriptedModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  listModels?: ModelClient["listModels"];

  /** `listed`: what the endpoint lists (for /model on a provider without `models`). */
  constructor(
    private readonly script: Step[],
    listed?: string[],
  ) {
    if (listed) this.listModels = async () => listed.map((id) => ({ id }) as never);
  }

  async stream(request: ModelRequest, handlers: { onText?(d: string): void }, signal: AbortSignal) {
    this.requests.push(request);
    const next = this.script.shift();
    if (!next) throw new Error("script exhausted");
    const reply = typeof next === "function" ? await next(signal) : next;
    for (const b of reply.content) if (b.type === "text") handlers.onText?.(b.text);
    if (reply.gate) {
      // An aborted call rejects, as the SDK's does.
      await Promise.race([
        reply.gate,
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
      ]);
    }
    return {
      id: "msg",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: reply.content,
      stop_reason: reply.stop ?? "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    } as unknown as ModelMessage;
  }
}
