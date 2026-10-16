import type { SessionSummary } from "@ivy/kernel";
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import stringWidth from "string-width";
import { relativeTime } from "../time.ts";

const TIME_WIDTH = 16;

/** Pad or cut to exactly `width` terminal columns (CJK-aware). */
function fit(text: string, width: number): string {
  let out = "";
  for (const ch of text.replace(/\s+/g, " ")) {
    if (stringWidth(out + ch) > width - 1) return `${out}…`.padEnd(width);
    out += ch;
  }
  return out + " ".repeat(Math.max(0, width - stringWidth(out)));
}

export function SessionPicker({
  sessions,
  width,
  onPick,
  onCancel,
}: {
  sessions: SessionSummary[];
  width: number;
  onPick(id: string): void;
  onCancel(): void;
}) {
  const [index, setIndex] = useState(0);
  const move = (dir: -1 | 1) => setIndex((i) => (i + dir + sessions.length) % sessions.length);

  useInput((input, key) => {
    if (key.upArrow || (key.ctrl && input === "p")) return move(-1);
    if (key.downArrow || (key.ctrl && input === "n")) return move(1);
    if (key.escape) return onCancel();
    if (key.return) {
      const chosen = sessions[index];
      if (chosen) onPick(chosen.id);
    }
  });

  const previewWidth = Math.max(10, width - TIME_WIDTH - 14);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>Resume a session</Text>
      {sessions.map((s, i) => {
        const active = i === index;
        return (
          <Text key={s.id} color={active ? "cyan" : undefined} dimColor={!active} wrap="truncate">
            {active ? "❯ " : "  "}
            {relativeTime(s.updatedAt).padEnd(TIME_WIDTH)}
            {fit(s.preview || "(no prompt)", previewWidth)}
            {` ${s.turns} turn${s.turns === 1 ? "" : "s"}`}
          </Text>
        );
      })}
      <Text dimColor>↑/↓ select · Enter resume · Esc cancel</Text>
    </Box>
  );
}
