// The vendor's own tools (DESIGN.md §5.2): what Ivy knows of each, in one place. Today that
// is web search, which a plugin asks for (`serverTools`) and the model may have.

import type Anthropic from "@anthropic-ai/sdk";
import { normalUrl, type ServerTool } from "@ivy/plugin-api";
import type { ResolvedCapabilities } from "./capabilities.ts";
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

/** Searches the model may run in one request (a continued reply gets as many again). */
const MAX_SEARCHES = 5;

/** The vendor's tools to offer: those plugins ask for, the model has, and no rule denies. */
export function serverToolDefs(
  wanted: ReadonlySet<ServerTool>,
  caps: ResolvedCapabilities,
  allowed: (name: ServerTool) => boolean,
): Anthropic.Beta.BetaToolUnion[] {
  return caps.webSearch && wanted.has("web_search") && allowed("web_search")
    ? [{ type: caps.webSearch, name: "web_search", max_uses: MAX_SEARCHES }]
    : [];
}

/**
 * The vendor's tool whose results a reply holds (search results, and the pages its
 * filtering code read), if any: outside content (docs/design/security.md#outside-content).
 */
export function readsOutside(content: ReadonlyArray<{ type: string }>): string | undefined {
  const found = content.find((b) => b.type !== "server_tool_use" && SERVER_BLOCKS.has(b.type));
  return found?.type.replace(/_tool_result$/, "");
}

/** A vendor tool's call, for the transcript; its filtering code's own calls aren't shown. */
export function serverToolCall(block: {
  type: string;
}): { id: string; name: string; input: unknown } | undefined {
  if (block.type !== "server_tool_use") return undefined;
  const call = block as Anthropic.Beta.BetaServerToolUseBlock;
  return call.name === "web_search"
    ? { id: call.id, name: call.name, input: call.input }
    : undefined;
}

/** A vendor tool's result, for the transcript, paired with its call by `id`. */
export function serverToolResult(block: {
  type: string;
}): { id: string; name: string; content: string; isError: boolean; outside: boolean } | undefined {
  if (block.type !== "web_search_tool_result") return undefined;
  const result = block as Anthropic.Beta.BetaWebSearchToolResultBlock;
  const text = searchResultText(result);
  // What a search found is outside content; a failed one brought nothing in.
  return { id: result.tool_use_id, name: "web_search", ...text, outside: !text.isError };
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

/** A vendor tool's call as the transcript names it, e.g. `looked up: finale date`. */
export function serverToolLabel(name: string, input: unknown): string | undefined {
  if (name === "web_search") return `looked up: ${(input as { query?: unknown })?.query ?? ""}`;
  return undefined;
}

/** What a search found, a line a page, as the transcript shows it. */
function searchResultText(block: {
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
 * model read anything since, they can't carry it off (docs/design/security.md#trust-model).
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
