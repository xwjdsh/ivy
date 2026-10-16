import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
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
import { definePlugin, defineTool } from "@ivy/plugin-api";
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
  constructor(private readonly script: Step[]) {}
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
      name: "save",
      description: "save",
      input: z.object({}),
      risk: "write",
      run: () => "saved",
    }),
  ],
});

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
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
    '[providers.anthropic]\napi_key = "test"\ndefault_model = "claude-opus-5-5"\nmodels = ["claude-sonnet-5-5", "claude-haiku-4-5"]\n',
  );
});
afterEach(() => cleanup?.());

async function start(script: Step[], configToml?: string) {
  if (configToml) writeFileSync(join(home, "config.toml"), configToml);
  const model = new FakeModel(script);
  const bridge: ConfirmBridge = { confirm: async () => false };
  const ivy = await createIvy({
    plugins: [writeTool],
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
      debug={false}
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
  expect(frame()).toMatch(/anthropic · claude-opus-5-5 · medium · .* · 10 in \/ 5 out/); // status bar
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
  expect(frame()).toContain("Allow t__save");
  await type("a");
  await tick(50);
  expect(frame()).toContain("saved");
  expect(frame()).toContain("done one");

  await type("again");
  await type(ENTER);
  await tick(50);
  expect(frame()).toContain("done two");
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

test("tool output is collapsed with a hint; Ctrl+O expands and redraws", async () => {
  const { type, frame, screen } = await start([
    { stop: "tool_use", content: [toolUse("a", "t__lines")] },
    { stop: "end_turn", content: [text("done")] },
  ]);
  await type("show lines");
  await type(ENTER);
  await tick(50);
  expect(frame()).toContain("l3");
  expect(frame()).not.toContain("l6");
  expect(frame()).toContain("+3 lines (ctrl+o to expand)");
  const clears = screen.clears;
  await type(CTRL_O);
  await tick(50);
  expect(screen.clears).toBe(clears + 1);
  expect(frame()).toContain("l6");
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
  await type(UP);
  await type(UP);
  await type(UP);
  await type(UP); // /help → /usage → /model → /resume
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
  expect(frame()).toContain("Switch model on anthropic");
  expect(frame()).toContain("❯ claude-opus-5-5  (current)");
  await type(DOWN);
  await type(ENTER);
  expect(frame()).toContain("Model: claude-sonnet-5-5 (this run only)");
  expect(frame()).toContain("claude-sonnet-5-5 · medium");
  await type("hi");
  await type(ENTER);
  await tick(50);
  expect(model.requests[0]?.model).toBe("claude-sonnet-5-5");
});

test("/model <name> switches directly; unknown names are rejected", async () => {
  const { type, frame } = await start([]);
  await type("/model claude-haiku-4-5");
  await type(ENTER);
  expect(frame()).toMatch(/claude-haiku-4-5 · \d{4}-/); // Haiku takes no effort setting
  await type("/model gpt-4");
  await type(ENTER);
  expect(frame()).toContain(
    "Unknown model gpt-4. Available: claude-opus-5-5, claude-sonnet-5-5, claude-haiku-4-5",
  );
});

test("with a single model, /model is hidden and explains why when typed", async () => {
  const { type, frame } = await start(
    [],
    '[providers.local]\napi_key = "k"\ndefault_model = "my/model"\n[agent]\nprovider = "local"\n',
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
  expect(frame()).toContain("Only one model is configured (my/model)");
});
