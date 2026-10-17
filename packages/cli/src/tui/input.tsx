import { Box, type DOMElement, Text, useBoxMetrics, useCursor, useInput, usePaste } from "ink";
import { useEffect, useRef, useState } from "react";
import { type CommandInfo, matchCommands } from "../commands.ts";
import * as E from "./editor.ts";

const PROMPT = "› ";
/** Rows taken by the box's top border, above the first text row. */
const BORDER_TOP = 1;
const INDENT = "  ";

interface Props {
  history: string[];
  /** Commands offered in the "/" list. */
  commands: CommandInfo[];
  /** Receives keystrokes (false while a dialog has focus). */
  active: boolean;
  /** A turn is running: typing ahead is fine, submitting is not. */
  busy: boolean;
  width: number;
  onSubmit(text: string): void;
  onChange(value: string): void;
}

export function Input({ history, commands, active, busy, width, onSubmit, onChange }: Props) {
  const [state, setState] = useState<E.EditorState>(E.empty);
  // Position in history while browsing with ↑/↓; null = editing a fresh draft.
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const draft = useRef("");

  const ref = useRef<DOMElement>(null);
  const metrics = useBoxMetrics(ref);
  const { setCursorPosition } = useCursor();

  // One spare column so the cursor fits after a full row instead of jumping to the next line.
  const textWidth = Math.max(10, width - PROMPT.length - 1);
  const rows = E.wrap(state.value, textWidth);

  useEffect(() => onChange(state.value), [state.value, onChange]);

  // Place the real terminal cursor so IME composition appears in the right spot.
  // This must run during render: Ink applies the position in the same commit
  // (useInsertionEffect). Calling it from useEffect lags one frame behind, and
  // after a layout change (e.g. closing the session picker) nothing re-renders
  // to fix it.
  if (active && metrics.hasMeasured) {
    const cell = E.cursorCell(rows, state.cursor);
    setCursorPosition({ x: PROMPT.length + cell.col, y: metrics.top + BORDER_TOP + cell.row });
  } else {
    setCursorPosition(undefined);
  }

  // Highlighted command in the "/" completion list. Tied to the text it was chosen for,
  // so editing the input resets the highlight to the first match.
  const matches = matchCommands(state.value, commands);
  const [selection, setSelection] = useState({ value: "", index: 0 });
  const selected =
    selection.value === state.value ? Math.min(selection.index, matches.length - 1) : 0;
  const moveSelection = (dir: -1 | 1) =>
    setSelection({ value: state.value, index: (selected + dir + matches.length) % matches.length });

  const set = (next: E.EditorState) => {
    setState(next);
    setHistoryIndex(null);
  };

  const browseHistory = (dir: -1 | 1) => {
    if (history.length === 0) return;
    if (historyIndex === null && dir === 1) return;
    if (historyIndex === null) draft.current = state.value;
    const next = (historyIndex ?? history.length) + dir;
    if (next < 0) return;
    if (next >= history.length) {
      setHistoryIndex(null);
      setState({ value: draft.current, cursor: draft.current.length });
      return;
    }
    const value = history[next] ?? "";
    setHistoryIndex(next);
    setState({ value, cursor: value.length });
  };

  const complete = (name: string) => set({ value: `${name} `, cursor: name.length + 1 });

  const submit = (current: E.EditorState) => {
    // Enter while the completion list is open picks the highlighted command:
    // commands with a required argument (a plugin's "/note <text>") are filled in, others run right away.
    const options = matchCommands(current.value, commands);
    const chosen = options[current.value === state.value ? selected : 0];
    if (chosen && chosen.name !== current.value) {
      if (chosen.args?.startsWith("<")) return complete(chosen.name);
      onSubmit(chosen.name);
      set(E.empty);
      return;
    }
    if (!current.value.trim()) {
      set(current);
      return;
    }
    onSubmit(current.value);
    set(E.empty);
  };

  const up = () => {
    const moved = E.verticalMove(state, -1);
    return moved ? setState(moved) : browseHistory(-1);
  };
  const down = () => {
    const moved = E.verticalMove(state, 1);
    return moved ? setState(moved) : browseHistory(1);
  };

  useInput(
    (input, key) => {
      const ctrlP = key.ctrl && input === "p";
      const ctrlN = key.ctrl && input === "n";
      if (matches.length > 0 && (key.upArrow || key.downArrow || ctrlP || ctrlN)) {
        return moveSelection(key.upArrow || ctrlP ? -1 : 1);
      }
      if (key.return) {
        // Shift+Enter needs kitty keyboard support; Option+Enter and a trailing "\" work everywhere.
        if (key.shift || key.meta) return set(E.insert(state, "\n"));
        if (state.value[state.cursor - 1] === "\\") {
          return set(E.insert(E.backspace(state), "\n"));
        }
        if (!busy) submit(state);
        return;
      }
      if (key.tab) {
        const chosen = matches[selected];
        if (chosen) complete(chosen.name);
        return;
      }
      if (key.upArrow || ctrlP) return up();
      if (key.downArrow || ctrlN) return down();
      if (key.leftArrow) return setState(E.left(state));
      if (key.rightArrow) return setState(E.right(state));
      if (key.home) return setState(E.lineStart(state));
      if (key.end) return setState(E.lineEnd(state));
      if (key.backspace) return set(E.backspace(state));
      if (key.delete) return set(E.deleteForward(state));
      if (key.ctrl) {
        if (input === "a") return setState(E.lineStart(state));
        if (input === "e") return setState(E.lineEnd(state));
        if (input === "u") return set(E.deleteToLineStart(state));
        if (input === "k") return set(E.deleteToLineEnd(state));
        if (input === "w") return set(E.deleteWordBefore(state));
        // Ctrl-C with text clears the input; otherwise the app interrupts or quits.
        if (input === "c" && !busy && state.value !== "") return set(E.empty);
        return;
      }
      if (key.meta || key.escape || !input) return;
      // Fast typing or an IME commit can deliver text and Enter in one chunk ("hi\r").
      // A trailing CR is Enter; CRs inside the chunk become newlines.
      const chunk = input.replace(/\r\n?/g, "\r");
      const enter = chunk.endsWith("\r");
      const next = E.insert(state, (enter ? chunk.slice(0, -1) : chunk).replace(/\r/g, "\n"));
      if (enter && !busy) submit(next);
      else set(next);
    },
    { isActive: active },
  );

  usePaste((text) => set(E.insert(state, text.replace(/\r\n?/g, "\n"))), { isActive: active });

  const placeholder = busy
    ? "Ivy is working… (type ahead, Ctrl-C to interrupt)"
    : "Message Ivy, or / for commands";

  return (
    <>
      {/* Top and bottom rules set the input apart from the transcript. */}
      <Box
        ref={ref}
        flexDirection="column"
        marginTop={1}
        borderStyle="single"
        borderLeft={false}
        borderRight={false}
        borderDimColor
      >
        {state.value === "" ? (
          <Text>
            <Text color="cyan">{PROMPT}</Text>
            <Text dimColor>{placeholder}</Text>
          </Text>
        ) : (
          rows.map((row, i) => (
            <Text key={row.start} wrap="truncate">
              <Text color="cyan">{i === 0 ? PROMPT : INDENT}</Text>
              {row.text}
            </Text>
          ))
        )}
      </Box>
      {matches.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {matches.map((c, i) => (
            <Text key={c.name} dimColor={i !== selected}>
              <Text color="cyan" bold={i === selected}>
                {i === selected ? "❯ " : "  "}
                {c.name}
              </Text>{" "}
              {c.args ? `${c.args} ` : ""}— {c.description}
            </Text>
          ))}
        </Box>
      )}
    </>
  );
}
