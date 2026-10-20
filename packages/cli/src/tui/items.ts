import type { Entry, ToolLabel } from "@ivy/protocol";

/** Something printed to the transcript. Once printed, items never change. */
export type Item =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; markdown: string }
  | {
      id: string;
      kind: "tool";
      /** Turn number in this process; undefined for items loaded from a session. */
      turn?: number;
      name: string;
      label: ToolLabel;
      input: unknown;
      result: string;
      isError: boolean;
    }
  | { id: string; kind: "info"; text: string; tone?: "warn" | "error" }
  | { id: string; kind: "turn_end"; summary: string; note?: string; noteTone?: "warn" | "error" };

let seq = 0;
export const itemId = () => `i${++seq}`;

/** A session's transcript, as the daemon sends it, as items to print. */
export function historyItems(entries: Entry[]): Item[] {
  return entries.map((e): Item => {
    if (e.kind === "user") return { id: itemId(), kind: "user", text: e.text };
    if (e.kind === "assistant") return { id: itemId(), kind: "assistant", markdown: e.markdown };
    return {
      id: itemId(),
      kind: "tool",
      name: e.name,
      label: e.label,
      input: e.input,
      result: e.running ? "(running)" : e.result,
      isError: e.isError,
    };
  });
}
