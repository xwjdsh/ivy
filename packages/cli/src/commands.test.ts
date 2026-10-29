import { expect, test } from "bun:test";
import { assertNoCommandClash, availableCommands } from "./commands.ts";

test("plugin commands go after the built-ins but before /help and /exit", () => {
  const names = availableCommands(true, [{ name: "/note", description: "" }]).map((c) => c.name);
  expect(names).toEqual([
    "/new",
    "/clear",
    "/model",
    "/effort",
    "/usage",
    "/status",
    "/verbose",
    "/note",
    "/help",
    "/exit",
  ]);
  expect(availableCommands(false).map((c) => c.name)).not.toContain("/model");
});

test("a plugin command may not take a built-in name", () => {
  expect(() => assertNoCommandClash([{ name: "/help", description: "" }])).toThrow(
    "Plugin command /help clashes with a built-in command",
  );
  expect(() => assertNoCommandClash([{ name: "/note", description: "" }])).not.toThrow();
});
