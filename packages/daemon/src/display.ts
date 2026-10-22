import type { Display } from "@ivy/protocol";

/**
 * Added to a session's system prompt so replies fit how they are shown; fixed when the
 * session starts, as the rest of the prompt is.
 */
export const DISPLAY_INSTRUCTIONS: Record<Display, string> = {
  markdown:
    "Your replies are shown in a chat window or a terminal that render Markdown, but this is a conversation: write as people talk, in short plain paragraphs. Use a list, a table or a code block only when the content is one (steps, a comparison the user asked for, code); keep tables narrow.",
  plain:
    "Your reply is printed as plain text to a terminal, or piped into another program. Don't use Markdown formatting unless the user asks for it.",
};
