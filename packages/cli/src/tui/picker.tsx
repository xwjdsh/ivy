import { Box, Text, useInput } from "ink";
import { type ReactNode, useState } from "react";

/** A bordered single-choice list: ↑/↓ or Ctrl+P/N to move, Enter to pick, Esc to cancel. */
export function Picker<T>({
  title,
  items,
  initialIndex = 0,
  itemKey,
  renderItem,
  onPick,
  onCancel,
}: {
  title: string;
  items: T[];
  initialIndex?: number;
  itemKey(item: T): string;
  /** One line per item (the highlighted one gets the cursor and color). */
  renderItem(item: T): ReactNode;
  onPick(item: T): void;
  onCancel(): void;
}) {
  const [index, setIndex] = useState(initialIndex);
  const move = (dir: -1 | 1) => setIndex((i) => (i + dir + items.length) % items.length);

  useInput((input, key) => {
    if (key.upArrow || (key.ctrl && input === "p")) return move(-1);
    if (key.downArrow || (key.ctrl && input === "n")) return move(1);
    if (key.escape) return onCancel();
    if (key.return) {
      const chosen = items[index];
      if (chosen !== undefined) onPick(chosen);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>{title}</Text>
      {items.map((item, i) => (
        <Text
          key={itemKey(item)}
          color={i === index ? "cyan" : undefined}
          dimColor={i !== index}
          wrap="truncate"
        >
          {i === index ? "❯ " : "  "}
          {renderItem(item)}
        </Text>
      ))}
      <Text dimColor>↑/↓ select · Enter choose · Esc cancel</Text>
    </Box>
  );
}
