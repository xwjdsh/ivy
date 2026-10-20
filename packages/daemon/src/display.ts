import type { Display } from "@ivy/protocol";

/**
 * Added to a session's system prompt so replies fit how they are shown; fixed when the
 * session starts, as the rest of the prompt is.
 */
export const DISPLAY_INSTRUCTIONS: Record<Display, string> = {
  markdown:
    "You are talking with the user in an interface that renders Markdown (headings, lists, bold, code blocks), often a terminal. Prefer short paragraphs. Avoid wide tables; they wrap badly in a terminal.",
  plain:
    "Your reply is printed as plain text to a terminal, or piped into another program. Don't use Markdown formatting unless the user asks for it.",
};
