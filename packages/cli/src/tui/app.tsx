import { errorMessage, type RequestInfo } from "@ivy/kernel";
import {
  addTokens,
  type CommandInfo,
  type DaemonState,
  formatTokens,
  onlyOneModel,
  type PermissionAnswer,
  type PermissionAsk,
  type Prompt,
  type SessionEvent,
  type SessionSummary,
  type SessionView,
  type Switched,
  stopNote,
  type Tokens,
  type ToolLabel,
  tokensFromUsage,
} from "@ivy/protocol";
import { Box, Static, Text, useApp, useInput, useWindowSize } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DaemonClient } from "../client.ts";
import { availableCommands, matchCommands } from "../commands.ts";
import type { InputHistory } from "../history.ts";
import { renderMarkdown, splitFinished } from "../markdown.ts";
import { formatCall } from "../verbose-format.ts";
import { Input } from "./input.tsx";
import { historyItems, type Item, itemId, sentText } from "./items.ts";
import { Picker, pickerHeight } from "./picker.tsx";
import { SessionPicker } from "./session-picker.tsx";
import {
  ItemView,
  PermissionPrompt,
  permissionPromptHeight,
  Spinner,
  StatusBar,
  ToolLine,
} from "./widgets.tsx";

/** Clears both Ink's frame and the terminal (incl. scrollback); wired to the Ink instance in main. */
export interface Screen {
  clear(): void;
}

export interface AppProps {
  /** The daemon, which runs the sessions; this UI only shows them. */
  client: DaemonClient;
  /** The session to show first, as the daemon sent it. */
  session: SessionView;
  /** The model and effort, as the daemon reported them at start. */
  state: DaemonState;
  /** What plugins add to the command list. */
  pluginCommands: CommandInfo[];
  history: InputHistory;
  screen: Screen;
  verbose: boolean;
  /** Open the session picker on start (`ivy -r` without an id). */
  pickSession?: boolean;
}

interface PendingTool {
  id: string;
  name: string;
  label: ToolLabel;
  input: unknown;
}

/** What of a session is still live, for a client joining a turn that runs. */
function liveOf(view: SessionView): { tools: PendingTool[]; text: string } {
  const tools = view.entries.flatMap((e) =>
    e.kind === "tool" && e.running
      ? [{ id: e.id, name: e.name, label: e.label, input: e.input }]
      : [],
  );
  return { tools, text: view.streaming ?? "" };
}

const EXIT_CONFIRM_MS = 2000;
const RESIZE_DEBOUNCE_MS = 100;
const NO_TOKENS: Tokens = { in: 0, cached: 0, out: 0 };

const helpText = (commands: CommandInfo[]) =>
  [
    "Commands:",
    ...commands.map((c) => `  ${`${c.name} ${c.args ?? ""}`.padEnd(18)}${c.description}`),
    "Keys:",
    "  Enter             send; while Ivy replies, it waits and is sent next",
    "  Shift/Option+Enter, Ctrl+J or \\ then Enter: new line",
    "  ↑ / ↓, Ctrl+P/N   history; in the / list: move the selection (Enter/Tab picks)",
    "  Ctrl+O            expand / collapse the last turn's tool output",
    "  Ctrl+L            redraw the screen",
    "  Esc / Ctrl-C      interrupt, dropping waiting messages · Ctrl-C clears the input",
    "  Ctrl-C twice or Ctrl-D: quit",
  ].join("\n");

export function App({
  client,
  session: initialSession,
  state: initialState,
  pluginCommands,
  history,
  screen,
  verbose,
  pickSession = false,
}: AppProps) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const width = Math.max(20, columns - 1);

  // The session shown. A ref too, so events arriving between renders are matched against
  // the current one.
  const [sessionId, setSessionId] = useState(initialSession.id);
  const sessionRef = useRef(initialSession.id);

  // Verbose view: request/response details, the hidden per-turn context, full tool input
  // and what plugin commands log. A ref so a turn in flight sees toggles at once.
  const [verboseOn, setVerboseOn] = useState(verbose);
  const verboseRef = useRef(verbose);
  const lastRequest = useRef<RequestInfo | undefined>(undefined);

  const [state, setState] = useState(initialState);
  const [tokens, setTokens] = useState(initialSession.tokens);
  const turnTokens = useRef(NO_TOKENS);
  // A turn joined while it runs is timed from when it was joined.
  const turnStarted = useRef(initialSession.running ? Date.now() : 0);

  const header = (): Item => ({
    id: itemId(),
    kind: "info",
    text: `Ivy · ${state.plugins} plugins, ${state.tools} tools · /help for commands`,
  });
  const [items, setItems] = useState<Item[]>(() => [
    header(),
    ...historyItems(initialSession.entries),
  ]);
  const push = useCallback((...next: Item[]) => setItems((prev) => [...prev, ...next]), []);
  const info = useCallback(
    (text: string, tone?: "warn" | "error") => push({ id: itemId(), kind: "info", text, tone }),
    [push],
  );
  const failed = (err: unknown) => info(errorMessage(err), "error");

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
  const initialLive = liveOf(initialSession);
  const bufRef = useRef(initialLive.text);
  const [streaming, setStreaming] = useState(initialLive.text);
  const [pendingTools, setPendingTools] = useState<PendingTool[]>(initialLive.tools);
  const [phase, setPhase] = useState<{ label: string; startedAt: number } | null>(() =>
    initialSession.running ? { label: "Thinking", startedAt: Date.now() } : null,
  );
  const busy = phase !== null;
  /** Messages waiting for the running turn, oldest first. */
  const [queue, setQueue] = useState<Prompt[]>(initialSession.queue);
  const [permission, setPermission] = useState<PermissionAsk | null>(
    initialSession.permission ?? null,
  );

  const [inputValue, setInputValue] = useState("");
  // Ctrl-C on an empty prompt arms exit for a moment; the hint disappears when it lapses.
  const [exitArmed, setExitArmed] = useState(false);
  useEffect(() => {
    if (!exitArmed) return;
    const timer = setTimeout(() => setExitArmed(false), EXIT_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [exitArmed]);

  const flushText = (all: boolean) => {
    const [done, rest] = all ? [bufRef.current, ""] : splitFinished(bufRef.current);
    if (done.trim()) push({ id: itemId(), kind: "assistant", markdown: done.trim() });
    bufRef.current = rest;
    setStreaming(rest);
  };

  const onEvent = (e: SessionEvent) => {
    if (e.sessionId !== sessionRef.current) return;
    switch (e.type) {
      case "prompt":
        setQueue((q) => [...q, e.prompt]);
        break;
      case "prompt_withdrawn":
        setQueue((q) => q.filter((p) => p.id !== e.promptId));
        break;
      case "turn_start":
        setQueue((q) => q.filter((p) => p.id !== e.prompt.id));
        turnTokens.current = NO_TOKENS;
        turnRef.current += 1;
        turnStarted.current = Date.now();
        setExpandedTurn(null);
        push({ id: itemId(), kind: "user", text: sentText(e.prompt.text, e.prompt.images) });
        setPhase({ label: "Thinking", startedAt: Date.now() });
        break;
      case "text":
        bufRef.current += e.delta;
        flushText(false);
        break;
      case "tool_call":
        flushText(true);
        setPendingTools((t) => [...t, { id: e.id, name: e.name, label: e.label, input: e.input }]);
        setPhase((p) => p && { ...p, label: `Running ${e.name}` });
        break;
      case "tool_result":
        setPendingTools((t) => {
          const pending = t.find((p) => p.id === e.id);
          push({
            id: itemId(),
            kind: "tool",
            turn: turnRef.current,
            name: e.name,
            label: e.label,
            input: pending?.input,
            result: e.content,
            isError: e.isError,
          });
          return t.filter((p) => p.id !== e.id);
        });
        setPhase((p) => p && { ...p, label: "Thinking" });
        break;
      case "notice":
        info(e.text, "warn");
        break;
      case "step": {
        // The step's message is complete: print the rest of its text before any step details.
        flushText(true);
        const step = tokensFromUsage(e.usage);
        turnTokens.current = addTokens(turnTokens.current, step);
        setTokens((t) => addTokens(t, step));
        if (verboseRef.current) info(formatCall(e, lastRequest.current));
        break;
      }
      case "context":
        if (verboseRef.current) info(`context:\n${e.text}`);
        break;
      case "request":
        lastRequest.current = e.info; // shown with the call's result, in one line
        break;
      case "permission":
        setPermission(e.ask);
        break;
      case "permission_answered":
        setPermission((p) => (p?.id === e.id ? null : p));
        break;
      case "turn_end": {
        flushText(true);
        setPendingTools([]);
        setPhase(null);
        const { end } = e;
        const note = stopNote(end);
        const seconds = ((Date.now() - turnStarted.current) / 1000).toFixed(1);
        push({
          id: itemId(),
          kind: "turn_end",
          summary: `${end.steps} step(s) · ${seconds}s · ${formatTokens(turnTokens.current)} tokens`,
          note,
          noteTone: end.stopReason === "error" ? "error" : "warn",
        });
        break;
      }
    }
  };
  // The subscription outlives renders; it calls whatever handler the latest render made.
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  /** Show a session (another, or the same one afresh): its transcript, and where it stands. */
  const show = (view: SessionView, note?: string) => {
    sessionRef.current = view.id;
    setSessionId(view.id);
    const live = liveOf(view);
    bufRef.current = live.text;
    setStreaming(live.text);
    setPendingTools(live.tools);
    turnStarted.current = Date.now();
    setPhase(view.running ? { label: "Thinking", startedAt: Date.now() } : null);
    setQueue(view.queue);
    setPermission(view.permission ?? null);
    setTokens(view.tokens);
    refresh([
      header(),
      ...(note ? [{ id: itemId(), kind: "info" as const, text: note }] : []),
      ...historyItems(view.entries),
    ]);
  };
  const showRef = useRef(show);
  showRef.current = show;

  // Follow the daemon's events. After a reconnect (the daemon restarted) the session is
  // read again, as events may have been missed meanwhile.
  useEffect(() => {
    const stop = new AbortController();
    let first = true;
    void client.follow(
      (e) => onEventRef.current(e),
      stop.signal,
      () => {
        if (first) {
          first = false;
          return;
        }
        client.session(sessionRef.current).then(
          (view) => showRef.current(view),
          (err) => info(errorMessage(err), "error"),
        );
      },
    );
    return () => stop.abort();
  }, [client, info]);

  const resumeSession = (id: string) => {
    client.session(id).then((view) => show(view, `Resumed ${id}`), failed);
  };

  // At most one dialog at a time: the session, model or effort picker.
  const [dialog, setDialog] = useState<
    | { kind: "sessions"; sessions: SessionSummary[] }
    | { kind: "model"; models: string[] }
    | { kind: "effort" }
    | null
  >(null);
  const closeDialog = () => setDialog(null);

  const commands = availableCommands(state.canSwitchModel, pluginCommands);

  /** Report a switch: saved to config.toml, or only until the daemon stops. */
  const switched = (label: string, result: Switched, note = "") => {
    setState(result);
    if (result.saved) info(`${label} (saved to config.toml).${note}`);
    else info(`${label} until Ivy restarts. ${result.error ?? ""}${note}`, "warn");
  };

  // /effort switches now and saves the choice as [generation] effort.
  const switchEffort = (level: string) => {
    if (level === state.effort) return;
    client.setEffort(level).then((result) => {
      const note =
        result.effortUsed === undefined
          ? ` ${result.model} doesn't take an effort setting, so it isn't sent.`
          : result.effortUsed !== level
            ? ` ${result.model} doesn't support it; ${result.effortUsed} is used.`
            : "";
      switched(`Effort: ${level}`, result, note);
    }, failed);
  };
  // /model switches now, to a model on any provider, and saves the choice as [agent] model.
  const switchModel = (name: string) => {
    if (name === state.model) return;
    // The daemon may have resolved a bare id to "<provider>/<id>": show what it chose.
    client.setModel(name).then((result) => switched(`Model: ${result.model}`, result), failed);
  };
  const openPicker = () => {
    client.sessions().then((all) => {
      const others = all.filter((s) => s.id !== sessionRef.current);
      if (others.length > 0) setDialog({ kind: "sessions", sessions: others });
      else info("No other sessions to resume.");
    }, failed);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount
  useEffect(() => {
    if (pickSession) openPicker();
  }, []);

  const runCommand = (line: string) => {
    const [cmd = "", ...args] = line.trim().split(/\s+/);
    const id = sessionRef.current;
    switch (cmd) {
      case "/exit":
      case "/quit":
        exit();
        return;
      case "/help":
        info(helpText(commands));
        return;
      case "/model": {
        // With a name, the daemon resolves it (the provider may be left out) or says why not.
        if (args[0]) return switchModel(args[0]);
        // Providers without a `models` limit are asked what they offer.
        client.models().then(({ models, errors }) => {
          for (const e of errors) info(`Couldn't list the models of ${e}`, "warn");
          if (models.length < 2) info(onlyOneModel(state.model), "warn");
          else setDialog({ kind: "model", models });
        }, failed);
        return;
      }
      case "/effort":
        if (args[0])
          switchEffort(args[0]); // the daemon checks the level
        else setDialog({ kind: "effort" });
        return;
      case "/status":
        client.status(id).then((r) => info(r.text), failed);
        return;
      case "/usage":
        client.usage(id).then((r) => info(r.text), failed);
        return;
      case "/verbose": {
        const on = !verboseRef.current;
        verboseRef.current = on;
        setVerboseOn(on);
        info(on ? "Verbose on. /status shows the current state." : "Verbose off.");
        return;
      }
      case "/new":
      case "/clear":
        client
          .createSession()
          .then((next) => client.session(next))
          .then((view) => show(view, `New session ${view.id}`), failed);
        return;
      case "/resume":
        if (args[0]) resumeSession(args[0]);
        else openPicker();
        return;
      default: {
        if (!pluginCommands.some((c) => c.name === cmd)) {
          info(`Unknown command ${cmd}. Try /help.`, "error");
          return;
        }
        const argText = line.trim().slice(cmd.length).trim();
        client.runCommand(id, cmd, argText).then((result) => {
          if (verboseRef.current) for (const l of result.logs) info(l);
          if (result.output) info(result.output);
        }, failed);
      }
    }
  };

  const onSubmit = (text: string) => {
    history.add(text);
    if (text.startsWith("/")) runCommand(text);
    // The daemon runs it now, or after the running turn; either way it shows in events.
    else client.send(sessionRef.current, text).catch(failed);
  };

  const answerPermission = (choice: PermissionAnswer) => {
    if (!permission) return;
    client.answer(permission.id, choice).catch(failed);
    setPermission(null);
  };

  const interrupt = () => {
    client.interrupt(sessionRef.current).catch(failed);
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (busy) return interrupt();
      if (dialog) return closeDialog();
      if (inputValue !== "") return; // the input box clears itself
      if (exitArmed) return exit();
      setExitArmed(true);
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
    (queue.length > 0 ? queue.length + 1 : 0) +
    (permission ? permissionPromptHeight(permission) : 0) +
    (dialog?.kind === "sessions" ? pickerHeight(dialog.sessions.length) : 0) +
    (dialog?.kind === "model" ? pickerHeight(dialog.models.length, true) : 0) +
    (dialog?.kind === "effort" ? state.efforts.length + 4 : 0) +
    completions.length;
  const maxLiveLines = Math.max(3, rows - reserved);
  // Ivy's text still streaming, laid out as it will be once finished (AssistantText).
  let liveLines =
    streaming.trim() === "" ? [] : renderMarkdown(streaming, Math.max(10, width - 2)).split("\n");
  const hiddenLines = liveLines.length > maxLiveLines ? liveLines.length - maxLiveLines + 1 : 0;
  if (hiddenLines > 0) liveLines = liveLines.slice(hiddenLines);

  return (
    <Box flexDirection="column">
      <Static key={staticKey} items={items}>
        {(item, index) => (
          <ItemView
            key={item.id}
            item={item}
            lead={items[index - 1]?.kind !== "assistant"}
            tight={item.kind === "tool" && items[index - 1]?.kind === "tool"}
            width={width}
            expandedTurn={expandedTurn}
            latestTurn={turnRef.current}
            verbose={verboseOn}
          />
        )}
      </Static>
      {liveLines.length > 0 && (
        <Box marginTop={1}>
          <Box width={2} flexShrink={0}>
            <Text color="magenta">{items.at(-1)?.kind !== "assistant" ? "●" : " "}</Text>
          </Box>
          <Box flexDirection="column">
            {hiddenLines > 0 && (
              <Text dimColor>… {hiddenLines} more lines above (still writing)</Text>
            )}
            <Text>{liveLines.join("\n")}</Text>
          </Box>
        </Box>
      )}
      {pendingTools.map((t, i) => (
        // Running tools sit right under the turn's finished ones, like those do.
        <Box key={t.id} marginTop={i > 0 || items.at(-1)?.kind === "tool" ? 0 : 1}>
          <ToolLine name={t.name} input={t.input} label={t.label} />
        </Box>
      ))}
      {phase && !permission && (
        <Box marginTop={1}>
          <Spinner label={phase.label} startedAt={phase.startedAt} />
        </Box>
      )}
      {permission && <PermissionPrompt call={permission} onChoose={answerPermission} />}
      {queue.length > 0 && (
        // Messages sent while Ivy replies: they run next, in this order.
        <Box flexDirection="column" marginTop={1}>
          {queue.map((p) => (
            <Text key={p.id} dimColor wrap="truncate-end">
              ⧗ {p.text.replace(/\s+/g, " ")}
            </Text>
          ))}
        </Box>
      )}
      {dialog?.kind === "model" && (
        <Picker
          title="Switch model (saved as default)"
          items={dialog.models}
          itemKey={(name) => name}
          initialIndex={Math.max(0, dialog.models.indexOf(state.model))}
          renderItem={(name) => (name === state.model ? `${name}  (current)` : name)}
          filterText={(name) => name}
          onPick={(name) => {
            closeDialog();
            switchModel(name);
          }}
          onCancel={closeDialog}
        />
      )}
      {dialog?.kind === "effort" && (
        <Picker
          title="Switch effort (saved as default)"
          items={state.efforts}
          initialIndex={Math.max(0, state.efforts.indexOf(state.effort))}
          itemKey={(level) => level}
          renderItem={(level) => (level === state.effort ? `${level}  (current)` : level)}
          onPick={(level) => {
            closeDialog();
            switchEffort(level);
          }}
          onCancel={closeDialog}
        />
      )}
      {dialog?.kind === "sessions" && (
        <SessionPicker
          sessions={dialog.sessions}
          width={width}
          onPick={(id) => {
            closeDialog();
            resumeSession(id);
          }}
          onCancel={closeDialog}
        />
      )}
      <Input
        history={history.entries}
        commands={commands}
        active={!permission && !dialog}
        busy={busy}
        width={width}
        onSubmit={onSubmit}
        onChange={setInputValue}
      />
      <StatusBar
        model={state.model}
        effort={state.effortUsed}
        sessionId={sessionId}
        tokens={formatTokens(tokens)}
        verbose={verboseOn}
        hint={busy ? "esc to interrupt" : exitArmed ? "Press Ctrl-C again to exit" : undefined}
      />
    </Box>
  );
}
