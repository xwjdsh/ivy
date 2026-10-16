import type { SessionSummary } from "@ivy/kernel";
import stringWidth from "string-width";
import { relativeTime } from "../time.ts";
import { Picker } from "./picker.tsx";

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
  const previewWidth = Math.max(10, width - TIME_WIDTH - 14);
  return (
    <Picker
      title="Resume a session"
      items={sessions}
      itemKey={(s) => s.id}
      renderItem={(s) =>
        `${relativeTime(s.updatedAt).padEnd(TIME_WIDTH)}${fit(s.preview || "(no prompt)", previewWidth)} ${s.turns} turn${s.turns === 1 ? "" : "s"}`
      }
      onPick={(s) => onPick(s.id)}
      onCancel={onCancel}
    />
  );
}
