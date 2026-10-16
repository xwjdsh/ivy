import type { ToolCallRequest } from "@ivy/kernel";
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
  model: string;
  effort: string;
  sessionId: string;
  costUsd: number;
  hint?: string;
}) {
  return (
    <Box justifyContent="space-between">
      <Text dimColor>
        {props.model} · {props.effort} · {props.sessionId} · ${props.costUsd.toFixed(4)}
      </Text>
      {props.hint && <Text dimColor>{props.hint}</Text>}
    </Box>
  );
}

export type PermissionChoice = "once" | "session" | "deny";

const CHOICES: Array<{ value: PermissionChoice; label: string; key: string }> = [
  { value: "once", label: "Yes", key: "y" },
  { value: "session", label: "Yes, for the rest of this session", key: "a" },
  { value: "deny", label: "No", key: "n" },
];

export function PermissionPrompt({
  call,
  onChoose,
}: {
  call: ToolCallRequest;
  onChoose(choice: PermissionChoice): void;
}) {
  const [index, setIndex] = useState(0);
  useInput((input, key) => {
    if (key.upArrow) setIndex((i) => (i + CHOICES.length - 1) % CHOICES.length);
    else if (key.downArrow) setIndex((i) => (i + 1) % CHOICES.length);
    else if (key.return) onChoose(CHOICES[index]?.value ?? "deny");
    else if (key.escape) onChoose("deny");
    else {
      const hit = CHOICES.find((c) => c.key === input.toLowerCase());
      if (hit) onChoose(hit.value);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text>
        Allow <Text bold>{call.name}</Text> <Text color="yellow">({call.risk})</Text>?
      </Text>
      <Text dimColor wrap="truncate-end">
        {JSON.stringify(call.input)}
      </Text>
      {CHOICES.map((c, i) => (
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

export function ToolLine({
  name,
  input,
  result,
  isError,
  expanded = false,
  expandable = false,
}: {
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
  expanded?: boolean;
  /** Show the Ctrl+O hint (only the latest turn can be expanded). */
  expandable?: boolean;
}) {
  const lines = result === undefined ? [] : formatResult(result);
  const limit = expanded ? TOOL_EXPANDED_MAX_LINES : TOOL_PREVIEW_LINES;
  const shown = lines.slice(0, limit);
  const hidden = lines.length - shown.length;
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text color={result === undefined ? "magenta" : isError ? "red" : "green"}>⏺ </Text>
        <Text bold>{name}</Text>
        <Text dimColor> {JSON.stringify(input)}</Text>
      </Text>
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
}: {
  item: Item;
  width: number;
  expandedTurn?: number | null;
  latestTurn?: number;
}) {
  switch (item.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text color="cyan">› </Text>
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
          <ToolLine {...item} expanded={latest && expandedTurn === item.turn} expandable={latest} />
        </Box>
      );
    }
    case "info":
      return (
        <Text
          color={item.tone === "error" ? "red" : item.tone === "warn" ? "yellow" : undefined}
          dimColor={item.tone === "dim" || item.tone === undefined}
        >
          {item.text}
        </Text>
      );
    case "turn_end":
      return (
        <Box flexDirection="column">
          {item.note && (
            <Text color={item.noteTone === "error" ? "red" : "yellow"}>{item.note}</Text>
          )}
          <Text dimColor>{item.summary}</Text>
        </Box>
      );
  }
}
