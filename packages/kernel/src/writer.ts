// Ivy speaking, for what she writes herself (docs/design/companion.md#notes-and-reviews): a day's
// note, a review. On the main model, as she is in conversation: her rules, SOUL.md and the plugins'
// session sections (her memory, so she knows the names; her journal, so her impressions are hers),
// then the task. No tools: what it reads can only shape what it writes.

import type { WriterModel } from "@ivy/plugin-api";
import type { Capabilities } from "./capabilities.ts";
import type { ModelRef, ProviderConfig } from "./config.ts";
import { completeText } from "./helper.ts";
import type { ModelClient, ModelRequest } from "./model.ts";

/** How long a piece of writing may take, whatever the caller's own signal allows. */
const TIMEOUT_MS = 5 * 60_000;

export class Writer implements WriterModel {
  constructor(
    private readonly opts: {
      clientFor(provider: ProviderConfig): ModelClient;
      capabilities: Capabilities;
      main(): ModelRef | undefined;
      /** Who Ivy is right now, as a conversation starting now would have it, without tools. */
      persona(): Promise<string>;
    },
  ) {}

  async complete(call: Parameters<WriterModel["complete"]>[0]): Promise<string> {
    const target = this.opts.main();
    if (!target) throw new Error("No model yet to write with");
    const caps = this.opts.capabilities.for(target);
    const request: ModelRequest = {
      model: target.id,
      max_tokens: call.maxTokens ?? 4000,
      // Ivy's prompt first and cached: a catch-up writes several in a row with it.
      system: [
        { type: "text", text: await this.opts.persona(), cache_control: { type: "ephemeral" } },
        { type: "text", text: `# Task\n${call.system}` },
      ],
      messages: [{ role: "user", content: call.prompt }],
      ...(caps.effort && { output_config: { effort: caps.effort } }),
    };
    return completeText({
      client: this.opts.clientFor(target.provider),
      capabilities: this.opts.capabilities,
      target,
      request,
      signal: call.signal,
      timeoutMs: TIMEOUT_MS,
      // Kept as written: half a note is no note.
      whole: true,
    });
  }
}
