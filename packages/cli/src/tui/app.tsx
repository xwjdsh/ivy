import {
  type AgentEvent,
  type Ivy,
  Session,
  type SessionSummary,
  summarizeUsage,
  type ToolCallRequest,
  type TurnResult,
} from "@ivy/kernel";
import { Box, Static, Text, useApp, useInput, useWindowSize } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { COMMANDS, matchCommands } from "../commands.ts";
import type { InputHistory } from "../history.ts";
import { renderMarkdown, splitFinished } from "../markdown.ts";
import { addTokens, formatTokens, type TokenCount, usageReport } from "../usage-report.ts";
import { Input } from "./input.tsx";
import { historyItems, type Item, itemId } from "./items.ts";
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
  debug: boolean;
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

const HELP = [
  "Commands:",
  ...COMMANDS.map((c) => `  ${`${c.name} ${c.args ?? ""}`.padEnd(18)}${c.description}`),
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
  debug,
  pickSession = false,
}: AppProps) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const width = Math.max(20, columns - 1);

  const sessionRef = useRef(initialSession);
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
      case "step": {
        const u = e.usage;
        const cached = u.cache_read_input_tokens ?? 0;
        const step: TokenCount = {
          in: u.input_tokens + cached + (u.cache_creation_input_tokens ?? 0),
          cached,
          out: u.output_tokens,
        };
        turnTokens.current = addTokens(turnTokens.current, step);
        setTokens((t) => addTokens(t, step));
        if (debug) {
          const u = e.usage;
          push({
            id: itemId(),
            kind: "info",
            text:
              `[step ${e.step}] stop=${e.stopReason} in=${u.input_tokens} out=${u.output_tokens} ` +
              `cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0} ` +
              `$${(e.costUsd ?? 0).toFixed(4)} ${(e.latencyMs / 1000).toFixed(1)}s` +
              (e.traceFile ? `\n  trace: ${e.traceFile}` : ""),
          });
        }
        break;
      }
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
        info(HELP);
        return;
      case "/usage":
        info(usageReport(ivy.paths.sessions, sessionRef.current.id));
        return;
      case "/new":
      case "/clear": {
        const next = Session.create(ivy.paths.sessions, ivy.config.model.name);
        switchSession(next);
        refresh([header(), { id: itemId(), kind: "info", text: `New session ${next.id}` }]);
        return;
      }
      case "/resume":
        if (args[0]) resumeSession(args[0]);
        else openPicker();
        return;
      default:
        info(`Unknown command ${cmd}. Try /help.`, "error");
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

  const completions = matchCommands(inputValue);

  // Keep the live area shorter than the screen: once Ink's dynamic output is taller
  // than the terminal it has to redraw everything on every update, which flickers.
  const reserved =
    6 +
    pendingTools.length * 2 +
    (permission ? 8 : 0) +
    (picker ? picker.length + 4 : 0) +
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
        active={!permission && !picker}
        busy={busy}
        width={width}
        onSubmit={onSubmit}
        onChange={setInputValue}
      />
      <StatusBar
        model={ivy.config.model.name}
        effort={ivy.config.model.effort}
        sessionId={sessionId}
        tokens={formatTokens(tokens)}
        hint={busy ? "esc to interrupt" : exitArmed ? "Press Ctrl-C again to exit" : undefined}
      />
    </Box>
  );
}
