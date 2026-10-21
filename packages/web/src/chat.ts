// A session as the chat window shows it: the daemon's view of it when opened, then its
// events applied one by one, as the TUI does (packages/cli/src/tui/app.tsx).

import {
  addTokens,
  type Entry,
  type PermissionAsk,
  type Prompt,
  type SessionChange,
  type SessionView,
  stopNote,
  type Tokens,
  tokensFromUsage,
} from "@ivy/protocol";

/** Something in the transcript: what the daemon sends, and what the window adds of its own. */
export type Item = Entry | { kind: "note"; text: string; tone: "warn" | "error" };

export interface Chat {
  id: string;
  items: Item[];
  /** The running turn's text still being written. */
  streaming: string;
  /** The prompt whose turn runs. */
  running?: Prompt;
  /** Prompts waiting for it, oldest first. */
  queue: Prompt[];
  tokens: Tokens;
  permission?: PermissionAsk;
}

export const NO_TOKENS: Tokens = { in: 0, cached: 0, out: 0 };

/** A session no message has been sent to yet. */
export const emptyChat = (id: string): Chat => ({
  id,
  items: [],
  streaming: "",
  queue: [],
  tokens: NO_TOKENS,
});

export const chatOf = (view: SessionView): Chat => ({
  id: view.id,
  items: view.entries,
  streaming: view.streaming ?? "",
  running: view.running,
  queue: view.queue,
  tokens: view.tokens,
  permission: view.permission,
});

/** The text written so far becomes a reply of its own (a tool call or the step's end follows). */
function settle(chat: Chat): Chat {
  if (!chat.streaming.trim()) return { ...chat, streaming: "" };
  return {
    ...chat,
    items: [...chat.items, { kind: "assistant", markdown: chat.streaming.trim() }],
    streaming: "",
  };
}

/** The chat after one of its session's events. */
export function apply(chat: Chat, e: SessionChange): Chat {
  switch (e.type) {
    case "prompt":
      return { ...chat, queue: [...chat.queue, e.prompt] };
    case "prompt_withdrawn":
      return { ...chat, queue: chat.queue.filter((p) => p.id !== e.promptId) };
    case "turn_start":
      return {
        ...chat,
        queue: chat.queue.filter((p) => p.id !== e.prompt.id),
        items: [
          ...chat.items,
          {
            kind: "user",
            text: e.prompt.text,
            ...(e.prompt.images && { images: e.prompt.images }),
          },
        ],
        streaming: "",
        running: e.prompt,
      };
    case "text":
      return { ...chat, streaming: chat.streaming + e.delta };
    case "tool_call": {
      const settled = settle(chat);
      const { id, name, label, input } = e;
      const tool: Item = { kind: "tool", id, name, label, input, result: "", isError: false };
      return { ...settled, items: [...settled.items, { ...tool, running: true }] };
    }
    case "tool_result":
      return {
        ...chat,
        items: chat.items.map((item) =>
          item.kind === "tool" && item.id === e.id
            ? { ...item, result: e.content, isError: e.isError, running: false }
            : item,
        ),
      };
    case "step":
      return { ...settle(chat), tokens: addTokens(chat.tokens, tokensFromUsage(e.usage)) };
    case "notice":
      return { ...chat, items: [...chat.items, { kind: "note", text: e.text, tone: "warn" }] };
    case "permission":
      return { ...chat, permission: e.ask };
    case "permission_answered":
      return chat.permission?.id === e.id ? { ...chat, permission: undefined } : chat;
    case "turn_end": {
      const settled = settle(chat);
      const note = stopNote(e.end);
      const items = settled.items.map((item) =>
        item.kind === "tool" && item.running ? { ...item, running: false } : item,
      );
      if (note) {
        items.push({
          kind: "note",
          text: note,
          tone: e.end.stopReason === "error" ? "error" : "warn",
        });
      }
      return { ...settled, items, running: undefined, permission: undefined };
    }
    default:
      return chat; // the verbose view's events (context, request): not shown here
  }
}
