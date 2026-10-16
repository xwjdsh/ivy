import type { Session } from "@ivy/kernel";

/** Something printed to the transcript. Once printed, items never change. */
export type Item =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; markdown: string }
  | {
      id: string;
      kind: "tool";
      /** Turn number in this process; undefined for items loaded from a resumed session. */
      turn?: number;
      name: string;
      input: unknown;
      result: string;
      isError: boolean;
    }
  | { id: string; kind: "info"; text: string; tone?: "dim" | "warn" | "error" }
  | { id: string; kind: "turn_end"; summary: string; note?: string; noteTone?: "warn" | "error" };

let seq = 0;
export const itemId = () => `i${++seq}`;

type Block = Exclude<Session["messages"][number]["content"], string>[number];

/** Rebuild transcript items from a stored session, pairing tool calls with their results. */
export function historyItems(messages: Session["messages"]): Item[] {
  const results = new Map<string, { content: string; isError: boolean }>();
  for (const m of messages) {
    if (m.role !== "user" || typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "tool_result") {
        results.set(b.tool_use_id, { content: toolResultText(b), isError: b.is_error ?? false });
      }
    }
  }

  const items: Item[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      items.push(
        m.role === "user"
          ? { id: itemId(), kind: "user", text: m.content }
          : { id: itemId(), kind: "assistant", markdown: m.content },
      );
      continue;
    }
    for (const b of m.content) {
      if (b.type === "text" && b.text.trim()) {
        items.push(
          m.role === "user"
            ? { id: itemId(), kind: "user", text: b.text }
            : { id: itemId(), kind: "assistant", markdown: b.text },
        );
      } else if (b.type === "tool_use") {
        const result = results.get(b.id) ?? { content: "(no result)", isError: true };
        items.push({
          id: itemId(),
          kind: "tool",
          name: b.name,
          input: b.input,
          result: result.content,
          isError: result.isError,
        });
      }
    }
  }
  return items;
}

function toolResultText(b: Extract<Block, { type: "tool_result" }>): string {
  if (typeof b.content === "string") return b.content;
  return (b.content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join(" ");
}
