// The helper model (DESIGN.md §5.2): side work that only extracts or sums up (a fetched page
// read for what was asked, a session's key points) runs on `[agent] helper_model`, a small
// fast model; unset, on the main model at low effort. A call carries no tools, so text it reads
// can only shape its answer; what it read from outside is outside content all the same, which
// its caller marks.

import type { HelperModel } from "@ivy/plugin-api";
import { type Capabilities, downgradable } from "./capabilities.ts";
import { type Config, type ModelRef, type ProviderConfig, resolveModel } from "./config.ts";
import type { ModelClient, ModelRequest } from "./model.ts";

/** One piece of side work: its own system prompt, and what it works on (see HelperModel). */
export type HelperCall = Parameters<HelperModel["complete"]>[0];

/** How long side work may take, whatever the caller's own signal allows. */
const TIMEOUT_MS = 120_000;

export class Helper {
  constructor(
    private readonly opts: {
      config: Config;
      clientFor(provider: ProviderConfig): ModelClient;
      capabilities: Capabilities;
      /** The main model, for when no helper is set. */
      main(): ModelRef | undefined;
    },
  ) {}

  /** The model side work runs on: `helper_model`, else the main model; none before either. */
  get model(): ModelRef | undefined {
    const ref = this.opts.config.agent.helper_model;
    return ref ? resolveModel(this.opts.config.providers, ref) : this.opts.main();
  }

  /** Whether side work has a model of its own, rather than the main one. */
  get separate(): boolean {
    return this.opts.config.agent.helper_model !== undefined;
  }

  /** Ask the helper; its answer as text. */
  async complete(call: HelperCall): Promise<string> {
    const target = this.model;
    if (!target) throw new Error("No model yet to do side work with");
    const request: ModelRequest = {
      model: target.id,
      max_tokens: call.maxTokens ?? 1024,
      system: [{ type: "text", text: call.system }],
      messages: [{ role: "user", content: call.prompt }],
    };
    // The main model standing in does it at low effort, where it takes one.
    if (!this.separate && this.opts.capabilities.for(target).effort) {
      request.output_config = { effort: "low" };
    }
    return completeText({
      client: this.opts.clientFor(target.provider),
      capabilities: this.opts.capabilities,
      target,
      request,
      signal: call.signal,
      timeoutMs: TIMEOUT_MS,
    });
  }
}

/**
 * One request without tools, its answer as text: within `timeoutMs` whatever the caller's
 * signal allows; an endpoint that refuses the effort asked again without it, as the turn loop
 * learns it (agent.ts). A refused answer is an error. One cut off (max_tokens) is too where it
 * must be `whole` (what is kept as written, a note); elsewhere it comes marked as cut off (a
 * page's answer is still worth having).
 */
export async function completeText(opts: {
  client: ModelClient;
  capabilities: Capabilities;
  target: ModelRef;
  request: ModelRequest;
  signal?: AbortSignal;
  timeoutMs: number;
  whole?: boolean;
}): Promise<string> {
  const ask = (sent: ModelRequest) => {
    const timeout = AbortSignal.timeout(opts.timeoutMs);
    return opts.client.stream(
      sent,
      {},
      opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    );
  };
  let message: Awaited<ReturnType<typeof ask>>;
  try {
    message = await ask(opts.request);
  } catch (err) {
    if (downgradable(err, opts.request) !== "effort") throw err;
    opts.capabilities.markUnsupported(opts.target, "effort");
    const { output_config: _, ...withoutEffort } = opts.request;
    message = await ask(withoutEffort);
  }
  if (message.stop_reason === "refusal") throw new Error("the answer was refused");
  const cut = message.stop_reason === "max_tokens";
  if (cut && opts.whole) throw new Error("the answer was cut off");
  const text = message.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("")
    .trim();
  return cut ? `${text} […]` : text;
}
