import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createIvy,
  type ModelClient,
  type ModelMessage,
  type ModelRequest,
  resolvePaths,
  Session,
} from "@ivy/kernel";
import { definePlugin, defineTool, type IvyPlugin } from "@ivy/plugin-api";
import { render } from "ink-testing-library";
import { z } from "zod";
import { InputHistory } from "../history.ts";
import { App, type ConfirmBridge } from "./app.tsx";

type Block = ModelMessage["content"][number];
type Step = { stop: string; content: Block[] } | ((signal: AbortSignal) => Promise<never>);

const text = (t: string) => ({ type: "text", text: t, citations: null }) as unknown as Block;
const toolUse = (id: string, name: string, input: unknown = {}) =>
  ({ type: "tool_use", id, name, input }) as unknown as Block;

class FakeModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  listModels?: ModelClient["listModels"];
  /** `listed`: what the endpoint lists (/model on a provider without `models`). */
  constructor(
    private readonly script: Step[],
    listed?: string[],
  ) {
    if (listed) {
      this.listModels = async () => listed.map((id) => ({ id }) as never);
    }
  }
  async stream(request: ModelRequest, handlers: { onText?(d: string): void }, signal: AbortSignal) {
    this.requests.push(request);
    const step = this.script.shift();
    if (!step) throw new Error("script exhausted");
    if (typeof step === "function") return step(signal);
    for (const b of step.content) if (b.type === "text") handlers.onText?.(b.text);
    return {
      id: "msg",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: step.content,
      stop_reason: step.stop,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    } as unknown as ModelMessage;
  }
}

const writeTool = definePlugin({
  id: "t",
  version: "0",
  description: "",
  tools: [
    defineTool({
      name: "lines",
      description: "six lines",
      input: z.object({}),
      risk: "read",
      run: () => "l1\nl2\nl3\nl4\nl5\nl6",
    }),
    defineTool({
      name: "wipe",
      description: "wipe",
      input: z.object({ path: z.string() }),
      risk: "dangerous",
      run: () => "wiped",
    }),
    defineTool({
      name: "save",
      description: "save",
      input: z.object({}),
      risk: "write",
      run: () => "saved",
    }),
  ],
});

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** Retry an assertion until it passes (or time runs out), instead of guessing a fixed wait. */
async function eventually(check: () => void, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      check();
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await tick(10);
    }
  }
}
const ENTER = "\r";
const CTRL_C = "\x03";
const CTRL_J = "\n";
const CTRL_O = "\x0f";

let home: string;
let cleanup: (() => void) | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ivy-tui-"));
  writeFileSync(
    join(home, "config.toml"),
    '[agent]\nmodel = "anthropic/claude-opus-5-5"\n[providers.anthropic]\napi_key = "test"\nmodels = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"]\n',
  );
});
afterEach(() => cleanup?.());

async function start(
  script: Step[],
  configToml?: string,
  extraPlugins: IvyPlugin[] = [],
  listed?: string[],
) {
  if (configToml) writeFileSync(join(home, "config.toml"), configToml);
  const model = new FakeModel(script, listed);
  const bridge: ConfirmBridge = { confirm: async () => "deny" };
  const ivy = await createIvy({
    plugins: [writeTool, ...extraPlugins],
    model,
    paths: resolvePaths(home),
    confirm: (call) => bridge.confirm(call),
  });
  const session = Session.create(ivy.paths.sessions, "claude-opus-5-5");
  const history = new InputHistory(join(home, "input_history.jsonl"));
  const screen = {
    clears: 0,
    clear() {
      this.clears++;
    },
  };
  const ui = render(
    <App
      ivy={ivy}
      session={session}
      history={history}
      bridge={bridge}
      screen={screen}
      verbose={false}
    />,
  );
  cleanup = ui.unmount;
  await tick();
  const type = async (s: string) => {
    ui.stdin.write(s);
    await tick();
  };
  return { ui, model, session, screen, type, frame: () => ui.lastFrame() ?? "" };
}

test("sends a message and renders the streamed Markdown answer", async () => {
  const { type, frame } = await start([{ stop: "end_turn", content: [text("Hello **there**")] }]);
  await type("hi");
  await type(ENTER);
  await tick(50);
  expect(frame()).toContain("> hi");
  expect(frame()).toContain("Hello there");
  expect(frame()).not.toContain("**");
  expect(frame()).toMatch(/1 step\(s\) · [\d.]+s · 10 in \/ 5 out tokens/);
  expect(frame()).toMatch(/anthropic\/claude-opus-5-5 · medium · .* · 10 in \/ 5 out/); // status bar
  expect(frame()).not.toContain("$");
});

test("risky tool asks once; 'for this session' skips later prompts", async () => {
  const { type, frame, model } = await start([
    { stop: "tool_use", content: [toolUse("a", "t__save")] },
    { stop: "end_turn", content: [text("done one")] },
    { stop: "tool_use", content: [toolUse("b", "t__save")] },
    { stop: "end_turn", content: [text("done two")] },
  ]);
  await type("save it");
  await type(ENTER);
  await eventually(() => expect(frame()).toContain("Allow t__save"));
  await type("s"); // yes, for this session
  await eventually(() => expect(frame()).toContain("done one"));
  expect(frame()).toContain("✓ t__save");

  await type("again");
  await type(ENTER);
  await eventually(() => expect(frame()).toContain("done two"));
  expect(frame().match(/Allow t__save/g)?.length ?? 0).toBe(0);
  expect(model.requests).toHaveLength(4);
});

test("denying a tool reports it and continues", async () => {
  const { type, frame } = await start([
    { stop: "tool_use", content: [toolUse("a", "t__save")] },
    { stop: "end_turn", content: [text("ok, not saving")] },
  ]);
  await type("save it");
  await type(ENTER);
  await type("n");
  await tick(50);
  expect(frame()).toContain("The user denied this tool call.");
  expect(frame()).toContain("ok, not saving");
});

test("Ctrl-C interrupts a running turn", async () => {
  const hang = (signal: AbortSignal) =>
    new Promise<never>((_, reject) =>
      signal.addEventListener("abort", () => reject(new Error("aborted"))),
    );
  const { type, frame } = await start([hang]);
  await type("long task");
  await type(ENTER);
  expect(frame()).toContain("Thinking");
  await type(CTRL_C);
  await tick(50);
  expect(frame()).toContain("Interrupted");
  expect(frame()).not.toContain("Thinking");
});

test("slash commands: completion, /help and /new", async () => {
  const { type, frame } = await start([]);
  await type("/he");
  expect(frame()).toContain("/help");
  await type(ENTER); // completes and runs /help
  expect(frame()).toContain("Commands:");
  const before = frame()
    .match(/2026|\d{4}-\d{2}-\d{2}-[0-9a-f]{8}/g)
    ?.at(-1);
  await type("/new");
  await type(ENTER);
  expect(frame()).toContain("New session");
  expect(
    frame()
      .match(/\d{4}-\d{2}-\d{2}-[0-9a-f]{8}/g)
      ?.at(-1),
  ).not.toBe(before);
});

test("multi-line input with a trailing backslash", async () => {
  const { type, frame, session } = await start([{ stop: "end_turn", content: [text("got it")] }]);
  await type("line one\\");
  await type(ENTER);
  await type("line two");
  expect(frame()).toContain("line one");
  expect(frame()).toContain("line two");
  await type(ENTER);
  await tick(50);
  expect(session.messages[0]).toEqual({ role: "user", content: "line one\nline two" });
});

test("text and Enter arriving in one chunk still submits", async () => {
  const { type, session } = await start([{ stop: "end_turn", content: [text("ok")] }]);
  await type("quick\r");
  await tick(50);
  expect(session.messages[0]).toEqual({ role: "user", content: "quick" });
});

test("Ctrl+J inserts a newline", async () => {
  const { type, session } = await start([{ stop: "end_turn", content: [text("ok")] }]);
  await type("a");
  await type(CTRL_J);
  await type("b");
  await type(ENTER);
  await tick(50);
  expect(session.messages[0]).toEqual({ role: "user", content: "a\nb" });
});

test("Ctrl-C clears typed text instead of arming exit", async () => {
  const { type, frame } = await start([]);
  await type("draft text");
  expect(frame()).toContain("draft text");
  await type(CTRL_C);
  expect(frame()).not.toContain("draft text");
  expect(frame()).not.toContain("Press Ctrl-C again");
});

test("tool calls are one line; Ctrl+O shows the output and redraws", async () => {
  const { type, frame, screen } = await start([
    { stop: "tool_use", content: [toolUse("a", "t__lines")] },
    { stop: "end_turn", content: [text("done")] },
  ]);
  await type("show lines");
  await type(ENTER);
  await eventually(() => expect(frame()).toContain("done"));
  expect(frame()).toContain("✓ t__lines");
  expect(frame()).not.toContain("l1");
  const clears = screen.clears;
  await type(CTRL_O);
  await eventually(() => expect(frame()).toContain("l6"));
  expect(screen.clears).toBe(clears + 1);
});

test("a failed tool shows ✗ and the first line of the error", async () => {
  const { type, frame } = await start([
    { stop: "tool_use", content: [toolUse("a", "t__save")] },
    { stop: "end_turn", content: [text("ok")] },
  ]);
  await type("save it");
  await type(ENTER);
  await eventually(() => expect(frame()).toContain("Allow t__save"));
  await type("n");
  await eventually(() => expect(frame()).toContain("✗ t__save"));
  expect(frame()).toContain("⎿ The user denied this tool call.");
});

test("/resume clears the screen and redraws that session's history", async () => {
  const { type, frame, screen, session } = await start([
    { stop: "end_turn", content: [text("first answer")] },
  ]);
  await type("first question");
  await type(ENTER);
  await tick(50);
  await type("/new");
  await type(ENTER);
  expect(screen.clears).toBe(1);
  await type(`/resume ${session.id}`);
  await type(ENTER);
  await tick(50);
  expect(screen.clears).toBe(2);
  expect(frame()).toContain(`Resumed ${session.id}`);
  expect(frame()).toContain("first answer");
});

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ESC = "\x1b";
const TAB = "\t";

test("/ list: arrows and Ctrl+P/N move the selection; Tab fills it in", async () => {
  const { type, frame } = await start([]);
  const CTRL_N = "\x0e";
  const CTRL_P = "\x10";
  await type("/");
  expect(frame()).toContain("❯ /new");
  await type(DOWN);
  await type(CTRL_N); // /new → /clear → /resume
  expect(frame()).toContain("❯ /resume");
  await type(CTRL_P);
  await type(UP); // back to /new
  expect(frame()).toContain("❯ /new");
  await type(UP); // wraps to the last item
  expect(frame()).toContain("❯ /exit");
  for (let i = 0; i < 7; i++) await type(UP); // /help, /verbose, /status, /usage, /effort, /model, /resume
  expect(frame()).toContain("❯ /resume");
  await type(TAB); // fills in "/resume " to type an id
  expect(frame()).toContain("› /resume"); // trailing space is trimmed in the frame
  expect(frame()).not.toContain("❯"); // list closes once an argument is being typed
});

test("typing narrows the list; Enter runs a command whose argument is optional", async () => {
  const { type, frame } = await start([]);
  await type("/");
  await type(DOWN);
  expect(frame()).toContain("❯ /clear");
  await type("r");
  expect(frame()).toContain("❯ /resume");
  expect(frame()).not.toContain("/clear");
  await type(ENTER);
  expect(frame()).toContain("No other sessions to resume.");
});

test("/resume without an id opens a picker; Enter resumes, Esc cancels", async () => {
  const sessions = join(home, "sessions");
  const older = Session.create(sessions, "m");
  older.append(
    { role: "user", content: "older question" },
    { role: "assistant", content: "older answer" },
  );
  await tick(5);
  const newer = Session.create(sessions, "m");
  newer.append(
    { role: "user", content: "newer question" },
    { role: "assistant", content: "newer answer" },
  );

  const { type, frame, screen } = await start([]);
  await type("/resume");
  await type(ENTER);
  expect(frame()).toContain("Resume a session");
  expect(frame()).toMatch(/❯ just now\s+newer question\s+1 turn/);
  await type(ESC);
  expect(frame()).not.toContain("Resume a session");

  await type("/resume");
  await type(ENTER);
  await type(DOWN);
  expect(frame()).toMatch(/❯ just now\s+older question/);
  await type(ENTER);
  await tick(50);
  expect(screen.clears).toBe(1);
  expect(frame()).toContain(`Resumed ${older.id}`);
  expect(frame()).toContain("older answer");
  expect(frame()).not.toContain("Resume a session");
});

test("/model opens a picker; choosing switches the model for later turns", async () => {
  const { type, frame, model } = await start([{ stop: "end_turn", content: [text("ok")] }]);
  await type("/model");
  await type(ENTER);
  expect(frame()).toContain("Switch model (saved as default)");
  expect(frame()).toContain("❯ anthropic/claude-opus-5-5  (current)");
  await type(DOWN);
  await type(ENTER);
  expect(frame()).toContain("Model: anthropic/claude-sonnet-5-5 (saved to config.toml)");
  expect(readFileSync(join(home, "config.toml"), "utf8")).toContain(
    'model = "anthropic/claude-sonnet-5-5"',
  );
  expect(frame()).toContain("anthropic/claude-sonnet-5-5 · medium");
  await type("hi");
  await type(ENTER);
  await tick(50);
  expect(model.requests[0]?.model).toBe("claude-sonnet-5-5");
});

test("/model <name> switches directly; unknown names are rejected", async () => {
  const { type, frame } = await start([]);
  await type("/model claude-haiku-4-5"); // the provider can be left out when unambiguous
  await type(ENTER);
  expect(frame()).toMatch(/anthropic\/claude-haiku-4-5 · \d{4}-/); // Haiku takes no effort setting
  await type("/model gpt-4");
  await type(ENTER);
  expect(frame()).toContain("Unknown model gpt-4. /model lists the available ones.");
});

// A proxy, so listing models doesn't also feed the official API's capability refresh.
const OPEN =
  '[agent]\nmodel = "p/a/one"\n[providers.p]\napi_key = "k"\nbase_url = "http://127.0.0.1:9"\n';

test("a provider without `models` offers what its endpoint lists; typing filters", async () => {
  const listed = Array.from({ length: 15 }, (_, i) => `a/m${i}`).concat("a/one", "b/special");
  const { type, frame, model } = await start(
    [{ stop: "end_turn", content: [text("ok")] }],
    OPEN,
    [],
    listed,
  );
  await type("/model");
  await type(ENTER);
  expect(frame()).toContain("Switch model (saved as default)");
  expect(frame()).toContain("❯ p/a/one  (current)");
  expect(frame()).toMatch(/↑ \d+ more/); // a long list scrolls
  await type("spec");
  expect(frame()).toContain("Filter: spec");
  expect(frame()).toContain("❯ p/b/special");
  expect(frame()).not.toContain("p/a/m1");
  await type(ENTER);
  expect(frame()).toContain("Model: p/b/special (saved to config.toml)");
  await type("hi");
  await type(ENTER);
  await tick(50);
  expect(model.requests[0]?.model).toBe("b/special");
  // The id alone works too when it's unambiguous (here the id is "a/m3").
  await type("/model a/m3");
  await type(ENTER);
  expect(frame()).toContain("Model: p/a/m3 (saved to config.toml)");
});

test("an endpoint that can't list its models: a warning, and /model says why", async () => {
  const { type, frame } = await start([], OPEN);
  await type("/");
  expect(frame()).toContain("/model"); // no limit, so there may be something to offer
  await type("\x15");
  await type("/model");
  await type(ENTER);
  expect(frame()).toContain("Couldn't list the models of p: this endpoint can't list its models");
  expect(frame()).toContain("Only one model is available (p/a/one)");
});

test("with a single model, /model is hidden and explains why when typed", async () => {
  const { type, frame } = await start(
    [],
    '[agent]\nmodel = "local/my/model"\n[providers.local]\napi_key = "k"\nmodels = ["my/model"]\n',
  );
  await type("/");
  expect(frame()).toContain("/usage");
  expect(frame()).not.toContain("Switch model"); // the model name "my/model" itself contains "/model"
  await type("\x15"); // Ctrl+U: clear the line
  await type("/help");
  await type(ENTER);
  expect(frame()).toContain("Commands:");
  expect(frame()).not.toContain("Switch model");
  await type("/model x");
  await type(ENTER);
  expect(frame()).toContain("Only one model is available (local/my/model)");
});

const notes = definePlugin({
  id: "notes",
  version: "0",
  description: "",
  contextFor: () => "Note: the user likes tea.",
  commands: [
    {
      name: "/note",
      args: "<text>",
      description: "Save a note",
      run: (args, ctx) => {
        ctx.log.info(`note saved: ${args}`);
        return `Saved: ${args}`;
      },
    },
  ],
});

test("plugin command shows in the / list and runs; its output is shown", async () => {
  const { type, frame } = await start([], undefined, [notes]);
  await type("/no");
  expect(frame()).toContain("/note <text> — Save a note");
  await type("\x15"); // Ctrl+U
  await type("/note buy milk");
  await type(ENTER);
  await tick(20);
  expect(frame()).toContain("Saved: buy milk");
});

test("a plugin command's log reaches the verbose view", async () => {
  const { type, frame } = await start([], undefined, [notes]);
  await type("/verbose");
  await type(ENTER);
  await type("/note tea");
  await type(ENTER);
  await eventually(() => expect(frame()).toContain("note saved: tea"));
});

test("plugin context reaches the model but isn't shown, live or after /resume", async () => {
  const { type, frame, model, session } = await start(
    [{ stop: "end_turn", content: [text("Tea it is.")] }],
    undefined,
    [notes],
  );
  await type("what should I drink?");
  await type(ENTER);
  await tick(50);
  const sent = JSON.stringify(model.requests[0]?.messages);
  expect(sent).toContain("<context>");
  expect(sent).toContain("the user likes tea");
  expect(frame()).toContain("> what should I drink?");
  expect(frame()).not.toContain("<context>");

  await type("/new");
  await type(ENTER);
  await type(`/resume ${session.id}`);
  await type(ENTER);
  await tick(50);
  expect(frame()).toContain("> what should I drink?");
  expect(frame()).not.toContain("likes tea");
});

test("a plugin's session section is frozen for the session and re-read on /new", async () => {
  let version = 1;
  const profile = definePlugin({
    id: "profile",
    version: "0",
    description: "",
    sessionPrompt: () => `Profile v${version}`,
  });
  const { type, model } = await start(
    [
      { stop: "end_turn", content: [text("one")] },
      { stop: "end_turn", content: [text("two")] },
      { stop: "end_turn", content: [text("three")] },
    ],
    undefined,
    [profile],
  );
  const system = (i: number) => JSON.stringify(model.requests[i]?.system);
  await type("hi");
  await type(ENTER);
  await eventually(() => expect(model.requests).toHaveLength(1));
  version = 2;
  await type("again");
  await type(ENTER);
  await eventually(() => expect(model.requests).toHaveLength(2));
  expect(system(0)).toContain("Profile v1");
  expect(system(1)).toBe(system(0)); // same bytes within a session

  await type("/new");
  await type(ENTER);
  await type("fresh");
  await type(ENTER);
  await eventually(() => expect(model.requests).toHaveLength(3));
  expect(system(2)).toContain("Profile v2");
});

test("a disabled plugin contributes no command and no context", async () => {
  const { type, frame, model } = await start(
    [{ stop: "end_turn", content: [text("ok")] }],
    '[agent]\nmodel = "anthropic/claude-opus-5-5"\n[providers.anthropic]\napi_key = "k"\n[plugins.notes]\nenabled = false\n',
    [notes],
  );
  await type("/");
  expect(frame()).not.toContain("/note");
  await type("\x15");
  await type("hi");
  await type(ENTER);
  await tick(50);
  expect(JSON.stringify(model.requests[0]?.messages)).not.toContain("<context>");
});

test("/effort opens a picker; the choice is used and saved to config.toml", async () => {
  const { type, frame, model } = await start([{ stop: "end_turn", content: [text("ok")] }]);
  await type("/effort");
  await type(ENTER);
  expect(frame()).toContain("Switch effort (saved as default)");
  expect(frame()).toContain("❯ medium  (current)");
  await type(DOWN);
  await type(ENTER);
  expect(frame()).toContain("Effort: high (saved to config.toml).");
  expect(frame()).toContain("claude-opus-5-5 · high ·");
  expect(readFileSync(join(home, "config.toml"), "utf8")).toContain('effort = "high"');
  await type("hi");
  await type(ENTER);
  await tick(50);
  expect(model.requests[0]?.output_config).toEqual({ effort: "high" });
});

test("/effort <level> switches directly; unknown levels are rejected", async () => {
  const { type, frame } = await start([]);
  await type("/effort low");
  await type(ENTER);
  expect(frame()).toContain("Effort: low (saved to config.toml).");
  await type("/effort turbo");
  await type(ENTER);
  expect(frame()).toContain("Unknown effort turbo. Levels: low, medium, high, xhigh, max");
});

test("/effort on a model without effort support says it isn't sent", async () => {
  const { type, frame } = await start([]);
  await type("/model claude-haiku-4-5");
  await type(ENTER);
  await type("/effort high");
  await type(ENTER);
  expect(frame().replace(/\s+/g, " ")).toContain(
    "anthropic/claude-haiku-4-5 doesn't take an effort setting, so it isn't sent.",
  );
});

test("/verbose toggles details: request/step lines, the hidden context, full tool input", async () => {
  const { type, frame } = await start(
    [
      { stop: "tool_use", content: [toolUse("a", "t__lines", { verbose: true })] },
      { stop: "end_turn", content: [text("done")] },
    ],
    undefined,
    [notes],
  );
  await type("/verbose");
  await type(ENTER);
  expect(frame()).toContain("Verbose on. /status shows the current state.");
  expect(frame()).not.toContain("refusal fallback"); // capability details live in /status
  expect(frame()).toMatch(/· verbose$/m);
  await type("show lines");
  await type(ENTER);
  await tick(50);
  const f = frame();
  expect(f).toContain("context:\n<context>\n## notes\nNote: the user likes tea.");
  expect(f).toContain("step 1 · 2 msgs · context system · tool_use"); // prompt + system context message
  expect(f).toMatch(/step 2 · \d+ msgs · context system · end_turn/);
  expect(f).not.toContain("→ step");
  expect(f).toContain('"verbose": true');
  expect(f).toContain("⎿ l1"); // verbose previews the result
  expect(f).toContain("+3 lines (ctrl+o to expand)");

  await type("/verbose");
  await type(ENTER);
  expect(frame()).toContain("Verbose off.");
  expect(frame()).not.toMatch(/· verbose$/m);
});

test("/status shows provider, capabilities, prompt parts, plugins and paths", async () => {
  const { type, frame } = await start([], undefined, [notes]);
  await type("/status");
  await type(ENTER);
  const f = frame().replace(/\s+/g, " ");
  expect(f).toContain("provider: anthropic · https://api.anthropic.com");
  expect(f).toContain("model: anthropic/claude-opus-5-5");
  expect(f).toMatch(/system prompt: rules\.md \d+ · total \d+ chars/);
  expect(f).toContain("notes (context, /note)");
  expect(f).toContain("config: ");
});

test("'Always' is saved to config.toml; a restart doesn't ask again", async () => {
  const script = (): Step[] => [
    { stop: "tool_use", content: [toolUse("a", "t__save")] },
    { stop: "end_turn", content: [text("saved it")] },
  ];
  const first = await start(script());
  await first.type("save it");
  await first.type(ENTER);
  await eventually(() => expect(first.frame()).toContain("Always (saved to config.toml)"));
  await first.type("a");
  await eventually(() => expect(first.frame()).toContain("saved it"));
  expect(readFileSync(join(home, "config.toml"), "utf8")).toContain(
    '[permissions]\nallow = ["t__save"]',
  );
  first.ui.unmount();

  const second = await start(script());
  await second.type("save again");
  await second.type(ENTER);
  await eventually(() => expect(second.frame()).toContain("saved it"));
  expect(second.frame()).not.toContain("Allow t__save");
});

test("a dangerous tool offers only Yes/No and shows the full input", async () => {
  const { type, frame } = await start([
    { stop: "tool_use", content: [toolUse("a", "t__wipe", { path: "/tmp/x" })] },
    { stop: "end_turn", content: [text("ok")] },
  ]);
  await type("wipe it");
  await type(ENTER);
  await eventually(() => expect(frame()).toContain("Allow t__wipe (dangerous)"));
  expect(frame()).toContain("(dangerous tool)"); // why it asks
  expect(frame()).toContain('"path": "/tmp/x"');
  expect(frame()).not.toContain("for the rest of this session");
  expect(frame()).not.toContain("Always");
  await type("n");
  await eventually(() => expect(frame()).toContain("✗ t__wipe"));
});

test("/status lists tools with their declared risk and the rules in effect", async () => {
  const { type, frame } = await start(
    [],
    '[agent]\nmodel = "anthropic/claude-opus-5-5"\n[providers.anthropic]\napi_key = "k"\n[permissions]\nask = ["t__lines"]\n',
  );
  await type("/status");
  await type(ENTER);
  const f = frame().replace(/\s+/g, " ");
  expect(f).toContain("t__lines (read)");
  expect(f).toContain("t__wipe (dangerous)");
  expect(f).toContain("permissions: ask t__lines");
});
