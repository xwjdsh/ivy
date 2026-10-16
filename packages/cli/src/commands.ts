export interface CommandInfo {
  name: string;
  args?: string;
  description: string;
}

export const COMMANDS: CommandInfo[] = [
  { name: "/new", description: "Start a new session and clear the screen" },
  { name: "/clear", description: "Same as /new" },
  { name: "/resume", args: "[id]", description: "Pick a session to resume, or give its id" },
  { name: "/model", args: "[name]", description: "Switch model for this run" },
  { name: "/usage", description: "Show token usage" },
  { name: "/help", description: "Show commands and keys" },
  { name: "/exit", description: "Quit" },
];

/**
 * Commands that make sense for this setup: built-ins (/model only when there is something
 * to switch to), then plugin commands, kept before /help and /exit.
 */
export function availableCommands(modelCount: number, plugin: CommandInfo[] = []): CommandInfo[] {
  const builtIn = COMMANDS.filter((c) => c.name !== "/model" || modelCount > 1);
  const tail = builtIn.filter((c) => c.name === "/help" || c.name === "/exit");
  return [...builtIn.filter((c) => !tail.includes(c)), ...plugin, ...tail];
}

/** Plugin commands may not reuse a built-in name. */
export function assertNoCommandClash(pluginCommands: CommandInfo[]): void {
  for (const c of pluginCommands) {
    if (COMMANDS.some((b) => b.name === c.name)) {
      throw new Error(`Plugin command ${c.name} clashes with a built-in command`);
    }
  }
}

/** Commands matching what the user has typed so far (only while typing the command word). */
export function matchCommands(input: string, commands: CommandInfo[] = COMMANDS): CommandInfo[] {
  if (!input.startsWith("/") || /\s/.test(input)) return [];
  return commands.filter((c) => c.name.startsWith(input));
}
