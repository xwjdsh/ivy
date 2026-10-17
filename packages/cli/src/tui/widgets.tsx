import type { PermissionChoice, ToolCallRequest } from "@ivy/kernel";
import { Box, Text, useAnimation, useInput } from "ink";
import { useState } from "react";
import { renderMarkdown } from "../markdown.ts";
import type { Item } from "./items.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner({ label, startedAt }: { label: string; startedAt: number }) {
  const { frame } = useAnimation({ interval: 80 });
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  return (
    <Text>
      <Text color="magenta">{FRAMES[frame % FRAMES.length]}</Text> {label}
      <Text dimColor> {seconds}s</Text>
    </Text>
  );
}

export function StatusBar(props: {
  /** Active provider name from [providers.<name>]. */
  provider: string;
  model: string;
  /** Omitted for models that don't take an effort setting. */
  effort?: string;
  sessionId: string;
  /** Session token totals, e.g. "12.3k in / 1.2k out". */
  tokens: string;
  verbose?: boolean;
  hint?: string;
}) {
  return (
    <Box justifyContent="space-between">
      <Text dimColor>
        {[
          props.provider,
          props.model,
          props.effort,
          props.sessionId,
          props.tokens,
          props.verbose ? "verbose" : "",
        ]
          .filter(Boolean)
          .join(" · ")}
      </Text>
      {props.hint && <Text dimColor>{props.hint}</Text>}
    </Box>
  );
}

const CHOICES: Array<{ value: PermissionChoice; label: string; key: string; remember?: true }> = [
  { value: "once", label: "Yes", key: "y" },
  { value: "session", label: "Yes, for the rest of this session", key: "s", remember: true },
  { value: "always", label: "Always (saved to permissions.json)", key: "a", remember: true },
  { value: "deny", label: "No", key: "n" },
];

/** Input lines shown in a permission prompt (all of them for dangerous tools). */
const PROMPT_INPUT_LINES = 12;

function promptLayout(call: ToolCallRequest) {
  // Only once or no when remembering would have no effect (dangerous tools, ask rules).
  const choices = CHOICES.filter((c) => call.canRemember || !c.remember);
  // Dangerous tools show their full input; others enough to judge, e.g. a memory being saved.
  const all = JSON.stringify(call.input, null, 2).split("\n");
  const max = call.risk === "dangerous" ? all.length : PROMPT_INPUT_LINES;
  return { choices, inputLines: all.slice(0, max), hidden: Math.max(0, all.length - max) };
}

/** Rows the permission prompt takes, so the live area can leave room for it. */
export function permissionPromptHeight(call: ToolCallRequest): number {
  const { choices, inputLines, hidden } = promptLayout(call);
  return 2 + 1 + inputLines.length + (hidden > 0 ? 1 : 0) + choices.length; // border, title
}

export function PermissionPrompt({
  call,
  onChoose,
}: {
  call: ToolCallRequest;
  onChoose(choice: PermissionChoice): void;
}) {
  const { choices, inputLines, hidden } = promptLayout(call);
  const [index, setIndex] = useState(0);
  useInput((input, key) => {
    if (key.upArrow) setIndex((i) => (i + choices.length - 1) % choices.length);
    else if (key.downArrow) setIndex((i) => (i + 1) % choices.length);
    else if (key.return) onChoose(choices[index]?.value ?? "deny");
    else if (key.escape) onChoose("deny");
    else {
      const hit = choices.find((c) => c.key === input.toLowerCase());
      if (hit) onChoose(hit.value);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text>
        Allow <Text bold>{call.name}</Text> <Text color="yellow">({call.risk})</Text>?{" "}
        <Text dimColor>({call.reason})</Text>
      </Text>
      <Text>{inputLines.join("\n")}</Text>
      {hidden > 0 && <Text dimColor>… {hidden} more lines</Text>}
      {choices.map((c, i) => (
        <Text key={c.value} color={i === index ? "cyan" : undefined}>
          {i === index ? "❯ " : "  "}
          {c.label} <Text dimColor>({c.key})</Text>
        </Text>
      ))}
    </Box>
  );
}

/** Lines of tool output shown when collapsed. */
export const TOOL_PREVIEW_LINES = 3;
/** Hard cap even when expanded, so one huge result can't flood the scrollback. */
const TOOL_EXPANDED_MAX_LINES = 500;

/** Pretty-print JSON results; leave everything else as is. */
function formatResult(result: string): string[] {
  const trimmed = result.trim();
  if (/^[[{]/.test(trimmed)) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2).split("\n");
    } catch {
      // not JSON
    }
  }
  return trimmed.split("\n");
}

/**
 * A tool call. Normally one line (status, name, short input) plus the first line of an
 * error; the result itself is shown with Ctrl+O (`expanded`) or in the verbose view.
 */
export function ToolLine({
  name,
  input,
  result,
  isError,
  expanded = false,
  expandable = false,
  verbose = false,
}: {
  name: string;
  input: unknown;
  /** Undefined while the tool is still running. */
  result?: string;
  isError?: boolean;
  expanded?: boolean;
  /** Show the Ctrl+O hint (only the latest turn can be expanded). */
  expandable?: boolean;
  /** Verbose view: full input and a preview of the result. */
  verbose?: boolean;
}) {
  const running = result === undefined;
  const lines = running ? [] : formatResult(result);
  const showResult = expanded || verbose;
  const shown = showResult
    ? lines.slice(0, expanded ? TOOL_EXPANDED_MAX_LINES : TOOL_PREVIEW_LINES)
    : isError
      ? lines.slice(0, 1)
      : [];
  const hidden = showResult ? lines.length - shown.length : 0;
  const args = JSON.stringify(input);
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        {running ? (
          <Text color="magenta">⏺ </Text>
        ) : isError ? (
          <Text color="red">✗ </Text>
        ) : (
          <Text color="green">✓ </Text>
        )}
        <Text bold>{name}</Text>
        {args !== "{}" && <Text dimColor> {args}</Text>}
      </Text>
      {verbose && args !== "{}" && (
        <Text dimColor>{JSON.stringify(input, null, 2).replace(/^/gm, "    ")}</Text>
      )}
      {shown.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static, never reordered
        <Text key={i} dimColor={!isError} color={isError ? "red" : undefined} wrap="truncate-end">
          {i === 0 ? "  ⎿ " : "    "}
          {line}
        </Text>
      ))}
      {hidden > 0 && (
        <Text dimColor>
          {"    "}… +{hidden} lines{expandable && !expanded ? " (ctrl+o to expand)" : ""}
        </Text>
      )}
    </Box>
  );
}

export function ItemView({
  item,
  width,
  expandedTurn = null,
  latestTurn,
  verbose = false,
}: {
  item: Item;
  width: number;
  expandedTurn?: number | null;
  latestTurn?: number;
  verbose?: boolean;
}) {
  switch (item.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text dimColor>{"> "}</Text>
          <Text bold>{item.text}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box marginTop={1}>
          <Text>{renderMarkdown(item.markdown, width)}</Text>
        </Box>
      );
    case "tool": {
      const latest = item.turn !== undefined && item.turn === latestTurn;
      return (
        <Box marginTop={1}>
          <ToolLine
            {...item}
            expanded={latest && expandedTurn === item.turn}
            expandable={latest}
            verbose={verbose}
          />
        </Box>
      );
    }
    case "info":
      return (
        <Box marginTop={1}>
          <Text
            color={item.tone === "error" ? "red" : item.tone === "warn" ? "yellow" : undefined}
            dimColor={item.tone === "dim" || item.tone === undefined}
          >
            {item.text}
          </Text>
        </Box>
      );
    case "turn_end":
      return (
        <Box flexDirection="column" marginTop={1}>
          {item.note && (
            <Text color={item.noteTone === "error" ? "red" : "yellow"}>{item.note}</Text>
          )}
          <Text dimColor>{item.summary}</Text>
        </Box>
      );
  }
}
