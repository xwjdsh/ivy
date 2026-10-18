// Added to the system prompt so replies fit how they are shown. Shared with the evals,
// which run with the TUI's instructions to match daily use.

export const TUI_INSTRUCTIONS =
  "You are talking with the user in a terminal UI that renders Markdown (headings, lists, bold, code blocks). Prefer short paragraphs. Avoid wide tables; they wrap badly in a terminal.";

export const PLAIN_INSTRUCTIONS =
  "Your reply is printed as plain text to a terminal, or piped into another program. Don't use Markdown formatting unless the user asks for it.";
