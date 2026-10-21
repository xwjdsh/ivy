import type Anthropic from "@anthropic-ai/sdk";

/**
 * Per-turn context (the time, todos due today, ...) is stored next to the user's message
 * and rendered per request, as a system message or a `<context>` text block (ContextMode).
 */
const OPEN = "<context>";
const CLOSE = "</context>";

export function contextBlock(sections: Array<{ id: string; text: string }>): string {
  if (sections.length === 0) return "";
  const body = sections.map((s) => `## ${s.id}\n${s.text}`).join("\n");
  return `${OPEN}\n${body}\n${CLOSE}`;
}

function isContextBlock(text: string): boolean {
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

    if (mode === "block") {
      // The context block goes first in the prompt it belongs to, before what the user typed.
      const ctx = isPrompt ? turnContext : undefined;
      out.push(
        ctx
          ? {
              ...m,
              content: [
                { type: "text", text: ctx },
                ...(typeof m.content === "string"
                  ? [{ type: "text" as const, text: m.content }]
                  : m.content),
              ],
            }
          : m,
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

/**
 * What the user typed in a user message, without the context block, or null for
 * messages that aren't prompts (tool results). A prompt of images alone typed "".
 */
export function promptText(message: MessageParam): string | null {
  if (message.role !== "user") return null;
  if (typeof message.content === "string") return message.content;
  if (message.content.some((b) => b.type === "tool_result")) return null;
  const texts = message.content.flatMap((b) =>
    b.type === "text" && !isContextBlock(b.text) ? [b.text] : [],
  );
  if (texts.length > 0) return texts.join("\n");
  return message.content.some((b) => b.type === "image") ? "" : null;
}
