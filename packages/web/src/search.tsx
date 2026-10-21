// Finding a past conversation without scrolling back to it (⌘K): a box over the conversation
// that narrows them by how they began or their day; Enter goes to the one lit, open above to
// carry on. The conversation itself stays the one way to browse them, by time.

import type { SessionSummary } from "@ivy/protocol";
import { Search as SearchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { dayLabel, matching, timeLabel } from "./sessions.ts";

export function Search(props: {
  /** The other conversations, newest first. */
  sessions: SessionSummary[];
  onPick(id: string): void;
  onClose(): void;
}) {
  const { onClose } = props;
  const [query, setQuery] = useState("");
  const [lit, setLit] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const shown = matching(props.sessions, query);
  const pick = (s: SessionSummary | undefined) => {
    if (s) props.onPick(s.id);
    onClose();
  };

  useEffect(() => {
    const away = (e: PointerEvent) => {
      const t = e.target as Element;
      // The button that opens it toggles it itself.
      if (!box.current?.contains(t) && !t.closest(".topbar .find")) onClose();
    };
    addEventListener("pointerdown", away);
    return () => removeEventListener("pointerdown", away);
  }, [onClose]);
  // The one lit stays in sight as the keys move it.
  useEffect(() => {
    list.current?.children[lit]?.scrollIntoView({ block: "nearest" });
  }, [lit]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // ↑↓, or Ctrl-P / Ctrl-N as in Emacs and the terminal.
    const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
    const step =
      e.key === "ArrowDown" || (ctrl && e.key === "n")
        ? 1
        : e.key === "ArrowUp" || (ctrl && e.key === "p")
          ? -1
          : 0;
    if (step) {
      e.preventDefault();
      setLit((i) => Math.min(Math.max(i + step, 0), Math.max(shown.length - 1, 0)));
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      pick(shown[lit]);
    } else if (e.key === "Escape") {
      e.preventDefault(); // the window's own Esc stays out of it
      onClose();
    }
  };

  return (
    <div className="search" ref={box}>
      <label className="find">
        <SearchIcon size={15} />
        <input
          // biome-ignore lint/a11y/noAutofocus: it is opened to type in
          autoFocus
          value={query}
          placeholder="Search conversations"
          onChange={(e) => {
            setQuery(e.target.value);
            setLit(0);
          }}
          onKeyDown={onKeyDown}
        />
        <kbd title="Opens this search">⌘K</kbd>
      </label>
      <div className="found" ref={list} role="listbox">
        {shown.map((s, i) => {
          const at = new Date(s.updatedAt);
          return (
            <button
              key={s.id}
              type="button"
              role="option"
              aria-selected={i === lit}
              className={i === lit ? "lit" : undefined}
              onPointerMove={() => setLit(i)}
              onClick={() => pick(s)}
            >
              <span className="preview">{s.preview || "Untitled"}</span>
              {s.busy && <span className="busy" title="Replying" />}
              <span className="when">
                {dayLabel(at)} {timeLabel(at)}
              </span>
            </button>
          );
        })}
        {shown.length === 0 && (
          <p className="none">
            {query.trim() ? "No conversation matches" : "No other conversations yet"}
          </p>
        )}
      </div>
    </div>
  );
}
