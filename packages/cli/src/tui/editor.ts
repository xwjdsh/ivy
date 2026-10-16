import stringWidth from "string-width";

/** Text being edited plus the cursor as a UTF-16 index into `value`. */
export interface EditorState {
  value: string;
  cursor: number;
}

export const empty: EditorState = { value: "", cursor: 0 };

export function insert(s: EditorState, text: string): EditorState {
  return {
    value: s.value.slice(0, s.cursor) + text + s.value.slice(s.cursor),
    cursor: s.cursor + text.length,
  };
}

export function backspace(s: EditorState): EditorState {
  if (s.cursor === 0) return s;
  const prev = prevBoundary(s.value, s.cursor);
  return { value: s.value.slice(0, prev) + s.value.slice(s.cursor), cursor: prev };
}

export function deleteForward(s: EditorState): EditorState {
  if (s.cursor >= s.value.length) return s;
  const next = nextBoundary(s.value, s.cursor);
  return { value: s.value.slice(0, s.cursor) + s.value.slice(next), cursor: s.cursor };
}

export function left(s: EditorState): EditorState {
  return { ...s, cursor: prevBoundary(s.value, s.cursor) };
}

export function right(s: EditorState): EditorState {
  return { ...s, cursor: nextBoundary(s.value, s.cursor) };
}

export function lineStart(s: EditorState): EditorState {
  return { ...s, cursor: s.value.lastIndexOf("\n", s.cursor - 1) + 1 };
}

export function lineEnd(s: EditorState): EditorState {
  const end = s.value.indexOf("\n", s.cursor);
  return { ...s, cursor: end === -1 ? s.value.length : end };
}

export function deleteToLineStart(s: EditorState): EditorState {
  const start = lineStart(s).cursor;
  return { value: s.value.slice(0, start) + s.value.slice(s.cursor), cursor: start };
}

export function deleteToLineEnd(s: EditorState): EditorState {
  const end = lineEnd(s).cursor;
  return { value: s.value.slice(0, s.cursor) + s.value.slice(end), cursor: s.cursor };
}

export function deleteWordBefore(s: EditorState): EditorState {
  const before = s.value.slice(0, s.cursor);
  const start = before.replace(/\S+\s*$|\s+$/, "").length;
  return { value: s.value.slice(0, start) + s.value.slice(s.cursor), cursor: start };
}

/** Logical line index and column (UTF-16 offset) of the cursor. */
export function cursorLineCol(s: EditorState): { line: number; col: number } {
  const before = s.value.slice(0, s.cursor);
  const line = before.split("\n").length - 1;
  return { line, col: s.cursor - (before.lastIndexOf("\n") + 1) };
}

/** Move to the previous/next logical line, keeping the column where possible. Null at the edge. */
export function verticalMove(s: EditorState, dir: -1 | 1): EditorState | null {
  const lines = s.value.split("\n");
  const { line, col } = cursorLineCol(s);
  const target = line + dir;
  if (target < 0 || target >= lines.length) return null;
  let offset = 0;
  for (let i = 0; i < target; i++) offset += (lines[i] ?? "").length + 1;
  return { ...s, cursor: offset + Math.min(col, (lines[target] ?? "").length) };
}

export interface VisualRow {
  text: string;
  /** Index in `value` where this row starts. */
  start: number;
}

/**
 * Wrap the value into rows of at most `width` terminal columns (CJK counts as 2),
 * so the real terminal cursor can be placed exactly (needed for IME input).
 */
export function wrap(value: string, width: number): VisualRow[] {
  const rows: VisualRow[] = [];
  let offset = 0;
  for (const line of value.split("\n")) {
    let row = "";
    let rowStart = offset;
    let rowWidth = 0;
    for (const ch of line) {
      const w = stringWidth(ch);
      if (rowWidth + w > width && row !== "") {
        rows.push({ text: row, start: rowStart });
        rowStart += row.length;
        row = "";
        rowWidth = 0;
      }
      row += ch;
      rowWidth += w;
    }
    rows.push({ text: row, start: rowStart });
    offset += line.length + 1;
  }
  return rows;
}

/**
 * Row and column (in terminal cells) of the cursor within `wrap(value, width)`.
 * The cursor stays on its row even after a full row, so callers must leave one
 * spare column to the right of `width` for it.
 */
export function cursorCell(rows: VisualRow[], cursor: number): { row: number; col: number } {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row && cursor >= row.start) {
      return { row: i, col: stringWidth(row.text.slice(0, cursor - row.start)) };
    }
  }
  return { row: 0, col: 0 };
}

// Step over whole code points so surrogate pairs (e.g. emoji) are never split.
function prevBoundary(value: string, i: number): number {
  if (i <= 0) return 0;
  const code = value.charCodeAt(i - 1);
  return code >= 0xdc00 && code <= 0xdfff && i >= 2 ? i - 2 : i - 1;
}

function nextBoundary(value: string, i: number): number {
  if (i >= value.length) return value.length;
  const code = value.charCodeAt(i);
  return code >= 0xd800 && code <= 0xdbff && i + 1 < value.length ? i + 2 : i + 1;
}
