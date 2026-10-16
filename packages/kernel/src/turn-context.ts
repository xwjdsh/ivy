import type Anthropic from "@anthropic-ai/sdk";

/**
 * Per-turn context (time, relevant memories, ...) travels as a `<context>` text block
 * at the start of the user message. That works on every Anthropic-compatible endpoint,
 * unlike mid-conversation system messages, and is stored in history like everything else.
 */
const OPEN = "<context>";
const CLOSE = "</context>";

export function contextBlock(sections: Array<{ id: string; text: string }>): string {
  if (sections.length === 0) return "";
  const body = sections.map((s) => `## ${s.id}\n${s.text}`).join("\n");
  return `${OPEN}\n${body}\n${CLOSE}`;
}

export function isContextBlock(text: string): boolean {
  return text.startsWith(OPEN);
}

type MessageParam = Anthropic.Beta.BetaMessageParam;

/**
 * How context reaches the model:
 * - "system": a `role: "system"` message with `clear_at: "next_user_message"` after the
 *   user's prompt, re-sent after each tool result of that turn. Operator-level trust, and
 *   it stops costing tokens once the turn is over. Anthropic API + recent Claude models only.
 * - "block": a `<context>` text block before the user's text. Works on every endpoint.
 */
export type ContextMode = "system" | "block";

/** Beta header needed for `clear_at` on system messages. */
export const CONTEXT_SYSTEM_BETA = "mid-conversation-system-clear-at-2026-08-21";

/**
 * Turn stored history into request messages. Deterministic: the same history and mode
 * always give the same bytes, so the prompt cache and thinking blocks stay valid.
 */
export function renderMessages(
  messages: MessageParam[],
  contextOf: (m: MessageParam) => string | undefined,
  mode: ContextMode,
): MessageParam[] {
  const out: MessageParam[] = [];
  let turnContext: string | undefined;
  messages.forEach((m, i) => {
    const isPrompt = promptText(m) !== null;
    if (isPrompt) turnContext = contextOf(m);
    const ctx = isPrompt ? contextOf(m) : undefined;

    if (mode === "block") {
      out.push(
        ctx && typeof m.content === "string" ? { ...m, content: userContent(ctx, m.content) } : m,
      );
      return;
    }

    out.push(m);
    // A system message must be followed by an assistant turn or be last; an interrupted
    // turn (user message right after user message) gets no copy.
    const next = messages[i + 1];
    if (m.role === "user" && turnContext && (!next || next.role === "assistant")) {
      out.push({ role: "system", content: turnContext, clear_at: "next_user_message" });
    }
  });
  return out;
}

/** User message content: the context block (if any) first, then what the user typed. */
function userContent(context: string, text: string): MessageParam["content"] {
  return context
    ? [
        { type: "text", text: context },
        { type: "text", text },
      ]
    : text;
}

/**
 * What the user typed in a user message, without the context block, or null for
 * messages that aren't prompts (tool results).
 */
export function promptText(message: MessageParam): string | null {
  if (message.role !== "user") return null;
  if (typeof message.content === "string") return message.content;
  if (message.content.some((b) => b.type === "tool_result")) return null;
  const texts = message.content.flatMap((b) =>
    b.type === "text" && !isContextBlock(b.text) ? [b.text] : [],
  );
  return texts.length > 0 ? texts.join("\n") : null;
}
