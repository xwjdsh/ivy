import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definePlugin, defineTool, type IvyPlugin } from "@ivy/plugin-api";
import { z } from "zod";
import { CONTEXT_MAX_CHARS, PluginHost } from "./plugins.ts";

const turn = { sessionId: "s", userText: "hello", now: new Date() };
const host = (configs: Record<string, Record<string, unknown>> = {}) =>
  new PluginHost(mkdtempSync(join(tmpdir(), "ivy-plugins-")), configs);
const plugin = (id: string, extra: Partial<IvyPlugin> = {}) =>
  definePlugin({ id, version: "0", description: id, ...extra });

test("turn context: one <context> block, sections in plugin-id order, empty ones skipped", async () => {
  const h = host();
  await h.register(plugin("b", { contextFor: () => "from b" }));
  await h.register(plugin("a", { contextFor: async () => "from a" }));
  await h.register(plugin("c", { contextFor: () => null }));
  await h.register(plugin("d", { contextFor: () => "   " }));
  expect(await h.turnContext(turn)).toBe("<context>\n## a\nfrom a\n## b\nfrom b\n</context>");
});

test("turn context: no plugin has anything → empty string", async () => {
  const h = host();
  await h.register(plugin("a"));
  expect(await h.turnContext(turn)).toBe("");
});

test("turn context: a failing or slow plugin is skipped, others still count", async () => {
  const h = host();
  await h.register(
    plugin("broken", {
      contextFor: () => {
        throw new Error("boom");
      },
    }),
  );
  await h.register(plugin("slow", { contextFor: () => new Promise(() => {}) }));
  await h.register(plugin("ok", { contextFor: () => "fine" }));
  expect(await h.turnContext(turn)).toBe("<context>\n## ok\nfine\n</context>");
});

test("turn context: each plugin's text is capped", async () => {
  const h = host();
  await h.register(plugin("big", { contextFor: () => "x".repeat(CONTEXT_MAX_CHARS + 500) }));
  const block = await h.turnContext(turn);
  expect(block).toContain(`${"x".repeat(CONTEXT_MAX_CHARS - 1)}…`);
  expect(block).not.toContain("x".repeat(CONTEXT_MAX_CHARS));
});

test("turn context gets the turn info", async () => {
  const h = host();
  let seen: unknown;
  await h.register(
    plugin("spy", {
      contextFor: (t) => {
        seen = t;
        return null;
      },
    }),
  );
  await h.turnContext(turn);
  expect(seen).toEqual(turn);
});

test("enabled = false: no tools, commands or context, and listed as disabled", async () => {
  const h = host({ off: { enabled: false } });
  let setupCalled = false;
  await h.register(
    plugin("off", {
      setup: () => {
        setupCalled = true;
      },
      contextFor: () => "should not appear",
      commands: [{ name: "/off", description: "", run: () => "x" }],
      tools: [
        defineTool({
          name: "t",
          description: "",
          input: z.object({}),
          risk: "read",
          run: () => "",
        }),
      ],
    }),
  );
  expect(setupCalled).toBe(false);
  expect(h.apiTools()).toEqual([]);
  expect(h.commands()).toEqual([]);
  expect(await h.turnContext(turn)).toBe("");
  expect(h.disabled).toEqual(["off"]);
});

test("enabled must be a boolean", async () => {
  await expect(host({ p: { enabled: "no" } }).register(plugin("p"))).rejects.toThrow(
    "Invalid [plugins.p]: enabled must be true or false",
  );
});

test("plugin settings are validated by its configSchema and passed to setup", async () => {
  const schema = z.strictObject({ limit: z.number().default(5) });
  let received: unknown;
  await host({ p: { limit: 9, enabled: true } }).register(
    plugin("p", {
      configSchema: schema,
      setup: (ctx) => {
        received = ctx.config;
      },
    }),
  );
  expect(received).toEqual({ limit: 9 });

  await expect(
    host({ p: { limit: "many" } }).register(plugin("p", { configSchema: schema })),
  ).rejects.toThrow("Invalid [plugins.p]");
});

test("a plugin without a configSchema rejects settings", async () => {
  await expect(host({ p: { foo: 1 } }).register(plugin("p"))).rejects.toThrow(
    "Invalid [plugins.p]: this plugin has no settings (got foo)",
  );
});

test("commands: listed sorted, looked up by name; bad names and duplicates rejected", async () => {
  const h = host();
  const cmd = (name: string) => ({ name, description: name, run: () => name });
  await h.register(plugin("a", { commands: [cmd("/zeta"), cmd("/alpha")] }));
  expect(h.commands().map((c) => c.def.name)).toEqual(["/alpha", "/zeta"]);
  expect(h.getCommand("/zeta")?.pluginId).toBe("a");

  await expect(h.register(plugin("b", { commands: [cmd("/alpha")] }))).rejects.toThrow(
    'Command /alpha is defined by both "a" and "b"',
  );
  await expect(host().register(plugin("c", { commands: [cmd("Bad")] }))).rejects.toThrow(
    'Invalid command name "Bad"',
  );
});

test("a dangerous tool can't be allowed by default", async () => {
  const tool = defineTool({
    name: "run",
    description: "",
    input: z.object({}),
    risk: "dangerous",
    defaultAllow: true,
    run: () => "",
  });
  await expect(host().register(plugin("shell", { tools: [tool] }))).rejects.toThrow(
    'Tool "shell__run" is dangerous and can\'t be allowed by default',
  );
});
