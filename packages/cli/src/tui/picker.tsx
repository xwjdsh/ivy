import { Box, Text, useInput } from "ink";
import { type ReactNode, useState } from "react";

/** Rows shown at once; longer lists scroll with the selection. */
const ROWS = 10;

/** Lines a picker of `count` items takes at most, border included. */
export function pickerHeight(count: number, filter = false): number {
  return Math.min(count, ROWS) + (count > ROWS ? 2 : 0) + (filter ? 1 : 0) + 4;
}

/**
 * A bordered single-choice list: ↑/↓ or Ctrl+P/N to move, Enter to pick, Esc to cancel.
 * With `filterText`, typing narrows the list to items containing every typed word.
 */
export function Picker<T>({
  title,
  items,
  initialIndex = 0,
  itemKey,
  renderItem,
  filterText,
  onPick,
  onCancel,
}: {
  title: string;
  items: T[];
  initialIndex?: number;
  itemKey(item: T): string;
  /** One line per item (the highlighted one gets the cursor and color). */
  renderItem(item: T): ReactNode;
  /** The text typing is matched against; without it, typing does nothing. */
  filterText?(item: T): string;
  onPick(item: T): void;
  onCancel(): void;
}) {
  const [index, setIndex] = useState(initialIndex);
  const [query, setQuery] = useState("");
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown =
    filterText && words.length
      ? items.filter((item) => {
          const text = filterText(item).toLowerCase();
          return words.every((w) => text.includes(w));
        })
      : items;
  const move = (dir: -1 | 1) =>
    setIndex((i) => (shown.length ? (i + dir + shown.length) % shown.length : 0));
  const filter = (next: string) => {
    setQuery(next);
    setIndex(0);
  };

  useInput((input, key) => {
    if (key.upArrow || (key.ctrl && input === "p")) return move(-1);
    if (key.downArrow || (key.ctrl && input === "n")) return move(1);
    if (key.escape) return onCancel();
    if (key.return) {
      const chosen = shown[index];
      if (chosen !== undefined) onPick(chosen);
      return;
    }
    if (!filterText) return;
    if (key.backspace || key.delete) return filter(query.slice(0, -1));
    if (input && !key.ctrl && !key.meta && !key.tab) filter(query + input);
  });

  // Keep the selection in view, about in the middle once the list scrolls.
  const start = Math.max(0, Math.min(index - Math.floor(ROWS / 2), shown.length - ROWS));
  const visible = shown.slice(start, start + ROWS);
  const below = shown.length - start - visible.length;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>{title}</Text>
      {filterText && <Text dimColor={!query}>{query ? `Filter: ${query}` : "Type to filter"}</Text>}
      {start > 0 && <Text dimColor>{`  ↑ ${start} more`}</Text>}
      {visible.map((item, i) => (
        <Text
          key={itemKey(item)}
          color={start + i === index ? "cyan" : undefined}
          dimColor={start + i !== index}
          wrap="truncate"
        >
          {start + i === index ? "❯ " : "  "}
          {renderItem(item)}
        </Text>
      ))}
      {shown.length === 0 && <Text dimColor>{"  No match"}</Text>}
      {below > 0 && <Text dimColor>{`  ↓ ${below} more`}</Text>}
      <Text dimColor>↑/↓ select · Enter choose · Esc cancel</Text>
    </Box>
  );
}
