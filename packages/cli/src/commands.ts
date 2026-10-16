export interface CommandInfo {
  name: string;
  args?: string;
  description: string;
}

export const COMMANDS: CommandInfo[] = [
  { name: "/new", description: "Start a new session and clear the screen" },
  { name: "/clear", description: "Same as /new" },
  { name: "/resume", args: "[id]", description: "Pick a session to resume, or give its id" },
  { name: "/usage", description: "Show token usage" },
  { name: "/help", description: "Show commands and keys" },
  { name: "/exit", description: "Quit" },
];

/** Commands matching what the user has typed so far (only while typing the command word). */
export function matchCommands(input: string): CommandInfo[] {
  if (!input.startsWith("/") || /\s/.test(input)) return [];
  return COMMANDS.filter((c) => c.name.startsWith(input));
}
