import {
  type AgentEvent,
  EFFORT_LEVELS,
  type Effort,
  type Ivy,
  Session,
  type SessionSummary,
  saveDefaultModel,
  saveEffort,
  setLogLevel,
  setLogSink,
  summarizeUsage,
  type ToolCallRequest,
  type TurnResult,
} from "@ivy/kernel";
import { Box, Static, Text, useApp, useInput, useWindowSize } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { availableCommands, type CommandInfo, matchCommands } from "../commands.ts";
import type { InputHistory } from "../history.ts";
import { renderMarkdown, splitFinished } from "../markdown.ts";
import { addTokens, formatTokens, type TokenCount, usageReport } from "../usage-report.ts";
import { formatRequest, formatStep, statusReport } from "../verbose-format.ts";
import { Input } from "./input.tsx";
import { historyItems, type Item, itemId } from "./items.ts";
import { Picker } from "./picker.tsx";
import { SessionPicker } from "./session-picker.tsx";
import {
  ItemView,
  type PermissionChoice,
  PermissionPrompt,
  Spinner,
  StatusBar,
  ToolLine,
} from "./widgets.tsx";

/** Lets the kernel's confirm() callback (created before React mounts) reach the UI. */
export interface ConfirmBridge {
  confirm(call: ToolCallRequest): Promise<boolean>;
}

/** Clears both Ink's frame and the terminal (incl. scrollback); wired to the Ink instance in main. */
export interface Screen {
  clear(): void;
}

export interface AppProps {
  ivy: Ivy;
  session: Session;
  history: InputHistory;
  bridge: ConfirmBridge;
  screen: Screen;
  verbose: boolean;
  /** Open the session picker on start (`ivy -r` without an id). */
  pickSession?: boolean;
}

interface PendingTool {
  id: string;
  name: string;
  input: unknown;
}

const EXIT_CONFIRM_MS = 2000;
const RESIZE_DEBOUNCE_MS = 100;

const STOP_NOTES: Partial<Record<TurnResult["stopReason"], string>> = {
  interrupted: "Interrupted",
  refusal: "The model declined this request",
  max_steps: "Stopped: too many steps in one turn",
  max_tokens: "Response hit max_tokens",
};

const helpText = (commands: CommandInfo[]) =>
  [
    "Commands:",
    ...commands.map((c) => `  ${`${c.name} ${c.args ?? ""}`.padEnd(18)}${c.description}`),
    "Keys:",
    "  Enter             send · Shift/Option+Enter, Ctrl+J or \\ then Enter: new line",
    "  ↑ / ↓, Ctrl+P/N   history; in the / list: move the selection (Enter/Tab picks)",
    "  Ctrl+O            expand / collapse the last turn's tool output",
    "  Ctrl+L            redraw the screen",
    "  Esc / Ctrl-C      interrupt · Ctrl-C clears the input · Ctrl-C twice or Ctrl-D: quit",
  ].join("\n");

export function App({
  ivy,
  session: initialSession,
  history,
  bridge,
  screen,
  verbose,
  pickSession = false,
}: AppProps) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const width = Math.max(20, columns - 1);

  const sessionRef = useRef(initialSession);

  // Verbose view: request/response details, the hidden per-turn context, full tool input,
  // capability decisions and plugin logs. A ref so a turn in flight sees toggles at once.
  const [verboseOn, setVerboseOn] = useState(verbose);
  const verboseRef = useRef(verbose);
  const requestedModel = useRef<string | undefined>(undefined);
  const tracerRef = useRef(ivy.tracer(initialSession.id));
  const [sessionId, setSessionId] = useState(initialSession.id);

  // Token counts: input includes cache reads/writes, i.e. the full prompt sent each call.
  const NO_TOKENS: TokenCount = { in: 0, cached: 0, out: 0 };
  const sessionTokens = (id: string): TokenCount => {
    const u = summarizeUsage(ivy.paths.sessions, { sessionId: id });
    return {
      in: u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens,
      cached: u.cacheReadTokens,
      out: u.outputTokens,
    };
  };
  const [tokens, setTokens] = useState(() => sessionTokens(initialSession.id));
  const turnTokens = useRef(NO_TOKENS);

  const header = (): Item => ({
    id: itemId(),
    kind: "info",
    text: `Ivy · ${ivy.plugins.list().length} plugins, ${ivy.plugins.apiTools().length} tools · /help for commands`,
  });
  const [items, setItems] = useState<Item[]>(() => [
    header(),
    ...historyItems(initialSession.messages),
  ]);
  const push = useCallback((...next: Item[]) => setItems((prev) => [...prev, ...next]), []);

  // stderr would corrupt the screen: logs go into the transcript when verbose, else nowhere.
  useEffect(() => {
    verboseRef.current = verboseOn;
    setLogLevel(verboseOn ? "debug" : "warn");
    setLogSink((line) => {
      if (verboseRef.current) push({ id: itemId(), kind: "info", text: line });
    });
  }, [verboseOn, push]);
  useEffect(() => () => setLogSink(null), []);

  // <Static> prints each item once. To reprint (new width, expanded tools, switched
  // session) we clear the terminal and remount it with a new key, as Gemini CLI does.
  const [staticKey, setStaticKey] = useState(0);
  const refresh = useCallback(
    (nextItems?: Item[]) => {
      screen.clear();
      if (nextItems) setItems(nextItems);
      setStaticKey((k) => k + 1);
    },
    [screen],
  );

  // Re-wrap history when the width changes (debounced: resizing fires many events).
  const lastColumns = useRef(columns);
  useEffect(() => {
    if (columns === lastColumns.current) return;
    const timer = setTimeout(() => {
      lastColumns.current = columns;
      refresh();
    }, RESIZE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [columns, refresh]);

  // Tool items remember their turn; Ctrl+O expands the latest turn's tool output.
  const turnRef = useRef(0);
  const [expandedTurn, setExpandedTurn] = useState<number | null>(null);

  // Assistant text still streaming; finished paragraphs move into `items`.
  const bufRef = useRef("");
  const [streaming, setStreaming] = useState("");
  const [pendingTools, setPendingTools] = useState<PendingTool[]>([]);
  const [phase, setPhase] = useState<{ label: string; startedAt: number } | null>(null);
  const busy = phase !== null;

  const abortRef = useRef<AbortController | null>(null);
  const allowedTools = useRef(new Set<string>());
  const [permission, setPermission] = useState<{
    call: ToolCallRequest;
    resolve(allowed: boolean): void;
  } | null>(null);

  const [inputValue, setInputValue] = useState("");
  const [exitArmedAt, setExitArmedAt] = useState(0);

  useEffect(() => {
    bridge.confirm = (call) =>
      allowedTools.current.has(call.name)
        ? Promise.resolve(true)
        : new Promise((resolve) => setPermission({ call, resolve }));
  }, [bridge]);

  // Tool inputs arrive with tool_call; keep them by id so the finished item can show them.
  const toolInputs = useRef(new Map<string, unknown>());

  const flushText = (all: boolean) => {
    const [done, rest] = all ? [bufRef.current, ""] : splitFinished(bufRef.current);
    if (done.trim()) push({ id: itemId(), kind: "assistant", markdown: done.trim() });
    bufRef.current = rest;
    setStreaming(rest);
  };

  const onEvent = (e: AgentEvent) => {
    switch (e.type) {
      case "text":
        bufRef.current += e.delta;
        flushText(false);
        break;
      case "tool_call":
        flushText(true);
        toolInputs.current.set(e.id, e.input);
        setPendingTools((t) => [...t, { id: e.id, name: e.name, input: e.input }]);
        setPhase((p) => p && { ...p, label: `Running ${e.name}` });
        break;
      case "tool_result":
        setPendingTools((t) => t.filter((p) => p.id !== e.id));
        push({
          id: itemId(),
          kind: "tool",
          turn: turnRef.current,
          name: e.name,
          input: toolInputs.current.get(e.id),
          result: e.content,
          isError: e.isError,
        });
        toolInputs.current.delete(e.id);
        setPhase((p) => p && { ...p, label: "Thinking" });
        break;
      case "notice":
        push({ id: itemId(), kind: "info", text: e.text, tone: "warn" });
        break;
      case "step": {
        // The step's message is complete: print the rest of its text before any step details.
        flushText(true);
        const u = e.usage;
        const cached = u.cache_read_input_tokens ?? 0;
        const step: TokenCount = {
          in: u.input_tokens + cached + (u.cache_creation_input_tokens ?? 0),
          cached,
          out: u.output_tokens,
        };
        turnTokens.current = addTokens(turnTokens.current, step);
        setTokens((t) => addTokens(t, step));
        if (verboseRef.current) {
          push({ id: itemId(), kind: "info", text: formatStep(e, requestedModel.current) });
        }
        break;
      }
      case "context":
        if (verboseRef.current) push({ id: itemId(), kind: "info", text: `context:\n${e.text}` });
        break;
      case "request":
        requestedModel.current = e.info.model;
        if (verboseRef.current) {
          push({ id: itemId(), kind: "info", text: formatRequest(e.step, e.info) });
        }
        break;
    }
  };

  const runTurn = async (text: string) => {
    turnTokens.current = NO_TOKENS;
    turnRef.current += 1;
    setExpandedTurn(null);
    push({ id: itemId(), kind: "user", text });
    const startedAt = Date.now();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase({ label: "Thinking", startedAt });
    let result: TurnResult;
    try {
      result = await ivy.agent.runTurn(sessionRef.current, text, {
        signal: controller.signal,
        onEvent,
        tracer: tracerRef.current,
      });
    } catch (err) {
      result = { stopReason: "error", steps: 0, costUsd: 0, error: String(err) };
    }
    flushText(true);
    setPendingTools([]);
    abortRef.current = null;
    setPhase(null);
    const note =
      result.stopReason === "error"
        ? `Error: ${result.error ?? "unknown"}`
        : STOP_NOTES[result.stopReason];
    push({
      id: itemId(),
      kind: "turn_end",
      summary: `${result.steps} step(s) · ${((Date.now() - startedAt) / 1000).toFixed(1)}s · ${formatTokens(turnTokens.current)} tokens`,
      note,
      noteTone: result.stopReason === "error" ? "error" : "warn",
    });
  };

  const switchSession = (next: Session) => {
    sessionRef.current = next;
    tracerRef.current = ivy.tracer(next.id);
    allowedTools.current.clear();
    setSessionId(next.id);
    setTokens(sessionTokens(next.id));
  };

  const resumeSession = (id: string) => {
    try {
      const next = Session.load(ivy.paths.sessions, id);
      switchSession(next);
      refresh([
        header(),
        { id: itemId(), kind: "info", text: `Resumed ${id}` },
        ...historyItems(next.messages),
      ]);
    } catch (err) {
      push({
        id: itemId(),
        kind: "info",
        text: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
    }
  };

  const [picker, setPicker] = useState<SessionSummary[] | null>(null);

  const models = ivy.config.activeProvider.models;
  const commands = availableCommands(
    models.length,
    ivy.plugins
      .commands()
      .map(({ def }) => ({ name: def.name, args: def.args, description: def.description })),
  );

  // /model switches now and saves the choice as the provider's default_model.
  const [model, setModel] = useState(ivy.agent.model);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);

  // /effort switches now and saves the choice as [generation] effort.
  const [effort, setEffortState] = useState<Effort>(ivy.capabilities.effort);
  const [effortPickerOpen, setEffortPickerOpen] = useState(false);
  const switchEffort = (level: Effort) => {
    if (level === effort) return;
    ivy.capabilities.setEffort(level);
    setEffortState(level);
    const used = ivy.capabilities.for(model).effort;
    const note =
      used === undefined
        ? ` ${model} doesn't take an effort setting, so it isn't sent.`
        : used !== level
          ? ` ${model} doesn't support it; ${used} is used.`
          : "";
    try {
      saveEffort(ivy.paths, level);
      push({ id: itemId(), kind: "info", text: `Effort: ${level} (saved to config.toml).${note}` });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      push({
        id: itemId(),
        kind: "info",
        text: `Effort: ${level} for this run only. ${reason}${note}`,
        tone: "warn",
      });
    }
  };
  const switchModel = (name: string) => {
    if (name === model) return;
    ivy.agent.setModel(name);
    setModel(name);
    if (verboseRef.current) {
      push({ id: itemId(), kind: "info", text: ivy.capabilities.explain(name).join("\n") });
    }
    try {
      saveDefaultModel(ivy.paths, ivy.config.activeProvider.name, name);
      push({ id: itemId(), kind: "info", text: `Model: ${name} (saved to config.toml)` });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      push({
        id: itemId(),
        kind: "info",
        text: `Model: ${name} for this run only. ${reason}`,
        tone: "warn",
      });
    }
  };
  const openPicker = () => {
    const others = Session.list(ivy.paths.sessions).filter((s) => s.id !== sessionRef.current.id);
    if (others.length > 0) setPicker(others);
    else push({ id: itemId(), kind: "info", text: "No other sessions to resume." });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount
  useEffect(() => {
    if (pickSession) openPicker();
  }, []);

  const runCommand = (line: string) => {
    const [cmd, ...args] = line.trim().split(/\s+/);
    const info = (text: string, tone?: "warn" | "error") =>
      push({ id: itemId(), kind: "info", text, tone });
    switch (cmd) {
      case "/exit":
      case "/quit":
        exit();
        return;
      case "/help":
        info(helpText(commands));
        return;
      case "/model": {
        const name = args[0];
        if (models.length < 2) {
          info(
            `Only one model is configured (${model}). Add more to \`models\` under [providers.${ivy.config.activeProvider.name}] to switch.`,
            "warn",
          );
        } else if (!name) {
          setModelPickerOpen(true);
        } else if (ivy.config.activeProvider.models.includes(name)) {
          switchModel(name);
        } else {
          info(
            `Unknown model ${name}. Available: ${ivy.config.activeProvider.models.join(", ")}`,
            "error",
          );
        }
        return;
      }
      case "/effort": {
        const level = args[0];
        if (!level) setEffortPickerOpen(true);
        else if ((EFFORT_LEVELS as readonly string[]).includes(level))
          switchEffort(level as Effort);
        else info(`Unknown effort ${level}. Levels: ${EFFORT_LEVELS.join(", ")}`, "error");
        return;
      }
      case "/status":
        info(statusReport(ivy, model, sessionRef.current.id, sessionRef.current.file));
        return;
      case "/verbose": {
        const on = !verboseRef.current;
        verboseRef.current = on;
        setVerboseOn(on);
        info(
          on
            ? `Verbose on. /status shows the current state.\n${ivy.capabilities.explain(model).join("\n")}`
            : "Verbose off.",
        );
        return;
      }
      case "/usage":
        info(usageReport(ivy.paths.sessions, sessionRef.current.id));
        return;
      case "/new":
      case "/clear": {
        const next = Session.create(ivy.paths.sessions, ivy.agent.model);
        switchSession(next);
        refresh([header(), { id: itemId(), kind: "info", text: `New session ${next.id}` }]);
        return;
      }
      case "/resume":
        if (args[0]) resumeSession(args[0]);
        else openPicker();
        return;
      default: {
        const command = cmd ? ivy.plugins.getCommand(cmd) : undefined;
        if (!command) {
          info(`Unknown command ${cmd}. Try /help.`, "error");
          return;
        }
        const argText = line
          .trim()
          .slice(cmd?.length ?? 0)
          .trim();
        Promise.resolve()
          .then(() =>
            command.def.run(argText, {
              sessionId: sessionRef.current.id,
              log: { debug() {}, info() {}, warn() {}, error() {} },
            }),
          )
          .then(
            (out) => {
              if (out) info(out);
            },
            (err) =>
              info(`${cmd} failed: ${err instanceof Error ? err.message : String(err)}`, "error"),
          );
      }
    }
  };

  const onSubmit = (text: string) => {
    history.add(text);
    if (text.startsWith("/")) runCommand(text);
    else void runTurn(text);
  };

  const answerPermission = (choice: PermissionChoice) => {
    if (!permission) return;
    if (choice === "session") allowedTools.current.add(permission.call.name);
    permission.resolve(choice !== "deny");
    setPermission(null);
  };

  const interrupt = () => {
    permission?.resolve(false);
    setPermission(null);
    abortRef.current?.abort();
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (busy) return interrupt();
      if (picker) return setPicker(null);
      if (modelPickerOpen) return setModelPickerOpen(false);
      if (effortPickerOpen) return setEffortPickerOpen(false);
      if (inputValue !== "") return; // the input box clears itself
      if (Date.now() - exitArmedAt < EXIT_CONFIRM_MS) return exit();
      setExitArmedAt(Date.now());
      return;
    }
    if (key.ctrl && input === "d" && !busy && inputValue === "") return exit();
    if (key.escape && busy && !permission) return interrupt();
    if (key.ctrl && input === "l") return refresh();
    if (key.ctrl && input === "o") {
      setExpandedTurn((t) => (t === null ? turnRef.current : null));
      refresh();
    }
  });

  const completions = matchCommands(inputValue, commands);

  // Keep the live area shorter than the screen: once Ink's dynamic output is taller
  // than the terminal it has to redraw everything on every update, which flickers.
  const reserved =
    6 +
    pendingTools.length * 2 +
    (permission ? 8 : 0) +
    (picker ? picker.length + 4 : 0) +
    (modelPickerOpen ? ivy.config.activeProvider.models.length + 4 : 0) +
    (effortPickerOpen ? EFFORT_LEVELS.length + 4 : 0) +
    completions.length;
  const maxLiveLines = Math.max(3, rows - reserved);
  let liveLines = streaming.trim() === "" ? [] : renderMarkdown(streaming, width).split("\n");
  const hiddenLines = liveLines.length > maxLiveLines ? liveLines.length - maxLiveLines + 1 : 0;
  if (hiddenLines > 0) liveLines = liveLines.slice(hiddenLines);
  const exitArmed = Date.now() - exitArmedAt < EXIT_CONFIRM_MS;

  return (
    <Box flexDirection="column">
      <Static key={staticKey} items={items}>
        {(item) => (
          <ItemView
            key={item.id}
            item={item}
            width={width}
            expandedTurn={expandedTurn}
            latestTurn={turnRef.current}
            verbose={verboseOn}
          />
        )}
      </Static>
      {liveLines.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          {hiddenLines > 0 && (
            <Text dimColor>… {hiddenLines} more lines above (still writing)</Text>
          )}
          <Text>{liveLines.join("\n")}</Text>
        </Box>
      )}
      {pendingTools.map((t) => (
        <Box key={t.id} marginTop={1}>
          <ToolLine name={t.name} input={t.input} />
        </Box>
      ))}
      {phase && !permission && (
        <Box marginTop={1}>
          <Spinner label={phase.label} startedAt={phase.startedAt} />
        </Box>
      )}
      {permission && <PermissionPrompt call={permission.call} onChoose={answerPermission} />}
      {modelPickerOpen && (
        <Picker
          title={`Switch model on ${ivy.config.activeProvider.name} (saved as default)`}
          items={ivy.config.activeProvider.models}
          itemKey={(name) => name}
          initialIndex={Math.max(0, ivy.config.activeProvider.models.indexOf(model))}
          renderItem={(name) => (name === model ? `${name}  (current)` : name)}
          onPick={(name) => {
            setModelPickerOpen(false);
            switchModel(name);
          }}
          onCancel={() => setModelPickerOpen(false)}
        />
      )}
      {effortPickerOpen && (
        <Picker
          title="Switch effort (saved as default)"
          items={[...EFFORT_LEVELS]}
          initialIndex={EFFORT_LEVELS.indexOf(effort)}
          itemKey={(level) => level}
          renderItem={(level) => (level === effort ? `${level}  (current)` : level)}
          onPick={(level) => {
            setEffortPickerOpen(false);
            switchEffort(level);
          }}
          onCancel={() => setEffortPickerOpen(false)}
        />
      )}
      {picker && (
        <SessionPicker
          sessions={picker}
          width={width}
          onPick={(id) => {
            setPicker(null);
            resumeSession(id);
          }}
          onCancel={() => setPicker(null)}
        />
      )}
      <Input
        history={history.entries}
        commands={commands}
        active={!permission && !picker && !modelPickerOpen && !effortPickerOpen}
        busy={busy}
        width={width}
        onSubmit={onSubmit}
        onChange={setInputValue}
      />
      <StatusBar
        provider={ivy.config.activeProvider.name}
        model={model}
        effort={effort && ivy.capabilities.for(model).effort}
        sessionId={sessionId}
        tokens={formatTokens(tokens)}
        verbose={verboseOn}
        hint={busy ? "esc to interrupt" : exitArmed ? "Press Ctrl-C again to exit" : undefined}
      />
    </Box>
  );
}
