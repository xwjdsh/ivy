import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";

const renderers = new Map<number, Marked>();

/** Render Markdown to ANSI text for the terminal, wrapped to `width` columns. */
export function renderMarkdown(text: string, width: number): string {
  let marked = renderers.get(width);
  if (!marked) {
    // The marked-terminal typings lag behind marked's extension type.
    marked = new Marked(markedTerminal({ width, reflowText: true, tab: 2 }) as never);
    renderers.set(width, marked);
  }
  return (marked.parse(text) as string).replace(/\s+$/, "");
}

/**
 * Split streamed Markdown into finished blocks and the still-growing tail.
 * A block is finished once a blank line follows it outside a code fence, so
 * finished blocks can be rendered once and moved out of the live area.
 */
export function splitFinished(text: string): [finished: string, rest: string] {
  let inFence = false;
  let boundary = -1;
  let pos = 0;
  const lines = text.split("\n");
  // The last element is a line still being written; never split inside it.
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && line.trim() === "" && i > 0 && (lines[i - 1] ?? "").trim() !== "") {
      boundary = pos;
    }
    pos += line.length + 1;
  }
  if (boundary <= 0) return ["", text];
  return [text.slice(0, boundary).replace(/\n+$/, ""), text.slice(boundary).replace(/^\n+/, "")];
}
