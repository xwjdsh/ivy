import type Anthropic from "@anthropic-ai/sdk";
import { normalUrl } from "@ivy/plugin-api";
import { promptText } from "./turn-context.ts";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlock = Anthropic.Beta.BetaContentBlockParam;

/**
 * Blocks of tools the vendor runs (DESIGN.md §5.2): its search, and the code it runs to
 * filter results. A reply keeps them, so the model that searched sees what it found.
 */
const SERVER_BLOCKS = new Set([
  "server_tool_use",
  "web_search_tool_result",
  "web_fetch_tool_result",
  "code_execution_tool_result",
  "bash_code_execution_tool_result",
  "text_editor_code_execution_tool_result",
]);

/**
 * Whether a reply holds what the vendor's tools brought back (search results, and the pages
 * its filtering code read): outside content (DESIGN.md §8.1).
 */
export function searched(content: ReadonlyArray<{ type: string }>): boolean {
  return content.some((b) => b.type !== "server_tool_use" && SERVER_BLOCKS.has(b.type));
}

/**
 * A reply as a model without the search tool may see it: the search blocks dropped, and the
 * citations that point into them. What it said stays.
 */
export function withoutServerTools(m: MessageParam): MessageParam {
  if (m.role !== "assistant" || typeof m.content === "string") return m;
  if (!m.content.some((b) => SERVER_BLOCKS.has(b.type))) return m;
  const content = m.content.flatMap((b): ContentBlock[] => {
    if (SERVER_BLOCKS.has(b.type)) return [];
    if (b.type === "text" && b.citations) return [{ type: "text", text: b.text }];
    return [b];
  });
  // A reply that was only a search keeps its place; an empty one would be refused.
  return { ...m, content: content.length ? content : [{ type: "text", text: "…" }] };
}

/** A vendor tool's call as the transcript names it, e.g. `search "finale date"`. */
export function serverToolLabel(name: string, input: unknown): string | undefined {
  if (name === "web_search") return `search "${(input as { query?: unknown })?.query ?? ""}"`;
  return undefined;
}

/** What a search found, a line a page, as the transcript shows it. */
export function searchResultText(block: {
  content: Array<{ title: string; url: string }> | { error_code: string };
}): {
  content: string;
  isError: boolean;
} {
  const found = block.content;
  if (!Array.isArray(found))
    return { content: `Search failed: ${found.error_code}`, isError: true };
  if (found.length === 0) return { content: "Nothing found.", isError: false };
  return { content: found.map((r) => `${r.title} — ${r.url}`).join("\n"), isError: false };
}

/**
 * Addresses the user wrote in a conversation, or its searches returned: written before the
 * model read anything since, they can't carry it off (DESIGN.md §6.3).
 */
export function namedUrls(messages: ReadonlyArray<MessageParam>): Set<string> {
  const urls = new Set<string>();
  const add = (text: string) => {
    const url = normalUrl(text);
    if (url) urls.add(url);
  };
  for (const m of messages) {
    if (m.role === "user") {
      // Up to a space or a bracket, without a sentence's last punctuation.
      for (const [found] of (promptText(m) ?? "").matchAll(
        /https?:\/\/[^\s<>"'`()（）「」【】]+/g,
      )) {
        add(found.replace(/[.,;:!?。，；：！？]+$/, ""));
      }
    } else if (typeof m.content !== "string") {
      for (const b of m.content) {
        if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
          for (const r of b.content) add(r.url);
        }
      }
    }
  }
  return urls;
}
