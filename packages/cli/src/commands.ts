import type { CommandInfo } from "@ivy/protocol";

export const COMMANDS: CommandInfo[] = [
  { name: "/new", description: "Start afresh: a new conversation, and a clear screen" },
  { name: "/clear", description: "Same as /new" },
  { name: "/model", args: "[name]", description: "Switch model (saved as default)" },
  { name: "/effort", args: "[level]", description: "Switch effort (saved as default)" },
  { name: "/usage", description: "Show token usage" },
  { name: "/status", description: "Show provider, model capabilities, prompt parts and paths" },
  { name: "/verbose", description: "Toggle request/response details, hidden context and logs" },
  { name: "/help", description: "Show commands and keys" },
  { name: "/exit", description: "Quit (or /quit)" },
];

/**
 * Commands that make sense for this setup: built-ins (/model only when there is something
 * to switch to), then plugin commands, kept before /help and /exit.
 */
export function availableCommands(
  canSwitchModel: boolean,
  plugin: CommandInfo[] = [],
): CommandInfo[] {
  const builtIn = COMMANDS.filter((c) => c.name !== "/model" || canSwitchModel);
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
export function matchCommands(input: string, commands: CommandInfo[]): CommandInfo[] {
  if (!input.startsWith("/") || /\s/.test(input)) return [];
  return commands.filter((c) => c.name.startsWith(input));
}
