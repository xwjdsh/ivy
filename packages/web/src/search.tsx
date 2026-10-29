// Finding what was said without scrolling back to it (⌘K): a box over the conversation that
// finds messages, the user's and Ivy's, holding every word typed; Enter goes to the one lit,
// where it is in the thread. The thread itself stays the one way to browse, by time.

import type { MessageHit } from "@ivy/protocol";
import { Search as SearchIcon } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import { scrollWithin } from "./menu.tsx";
import { dayLabel, timeLabel } from "./sessions.ts";

/** A message found, to go to: in its conversation, the nth of its role holding the words. */
export interface Found {
  id: string;
  role: MessageHit["role"];
  nth: number;
  words: string[];
}

/** Typing settles this long before it is searched. */
const SETTLE_MS = 150;

const wordsOf = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);

/**
 * The message found, as shown in a conversation (`.user`, `.assistant`): the nth of its role
 * holding every word, else the first holding the first word. Ivy's words may show in more
 * parts than the history has them (split by her tool calls), so this is a best match.
 */
export function messageIn(container: HTMLElement, found: Found): HTMLElement | undefined {
  const all = [...container.querySelectorAll<HTMLElement>(`:scope > .${found.role}`)];
  const holds = (el: HTMLElement, words: string[]) => {
    const text = (el.textContent ?? "").toLowerCase();
    return words.every((w) => text.includes(w));
  };
  const every = all.filter((el) => holds(el, found.words));
  return every[found.nth] ?? every.at(-1) ?? all.find((el) => holds(el, found.words.slice(0, 1)));
}

/** Lit up a moment where it is gone to, then as before. */
export function lightUp(el: HTMLElement) {
  el.classList.remove("lit-up");
  void el.offsetWidth; // again, if it was just lit
  el.classList.add("lit-up");
  el.addEventListener("animationend", () => el.classList.remove("lit-up"), { once: true });
}

/** A snippet with each word typed marked where it is. */
function Marked({ text, words }: { text: string; words: string[] }) {
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const parts = text.split(new RegExp(`(${escaped.join("|")})`, "gi"));
  return (
    <>
      {parts.map((part, i) =>
        // Split on a group: the matches are every other part.
        // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed text
        i % 2 === 1 ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>,
      )}
    </>
  );
}

export function Search(props: { onPick(found: Found): void; onClose(): void }) {
  const { onClose } = props;
  const [query, setQuery] = useState("");
  // What was found, with the words it was found by: typing on doesn't change them.
  const [{ hits, words }, setFound] = useState<{ hits: MessageHit[]; words: string[] }>({
    hits: [],
    words: [],
  });
  const [lit, setLit] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // Searched once typing settles; an answer to an older query is let go.
  useEffect(() => {
    if (!query.trim()) {
      setFound({ hits: [], words: [] });
      return;
    }
    let current = true;
    const settle = setTimeout(() => {
      api.search(query).then(
        (found) => {
          if (!current) return;
          setFound({ hits: found, words: wordsOf(query) });
          setLit(0);
        },
        () => current && setFound({ hits: [], words: [] }),
      );
    }, SETTLE_MS);
    return () => {
      current = false;
      clearTimeout(settle);
    };
  }, [query]);
  const pick = (hit: MessageHit | undefined) => {
    if (hit) props.onPick({ id: hit.sessionId, role: hit.role, nth: hit.nth, words });
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
    const el = list.current?.children[lit];
    if (list.current && el instanceof HTMLElement) scrollWithin(list.current, el);
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
      setLit((i) => Math.min(Math.max(i + step, 0), Math.max(hits.length - 1, 0)));
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      pick(hits[lit]);
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
          placeholder="Search messages"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <kbd title="Opens this search">⌘K</kbd>
      </label>
      <div className="found" ref={list} role="listbox">
        {hits.map((hit, i) => {
          const at = new Date(hit.ts);
          return (
            <button
              key={`${hit.sessionId} ${hit.ts} ${hit.role} ${hit.nth}`}
              type="button"
              role="option"
              aria-selected={i === lit}
              className={i === lit ? "lit" : undefined}
              onPointerMove={() => setLit(i)}
              onClick={() => pick(hit)}
            >
              <span className="who">{hit.role === "user" ? "You" : "Ivy"}</span>
              <span className="preview">
                <Marked text={hit.text} words={words} />
              </span>
              <span className="when">
                {dayLabel(at)} {timeLabel(at)}
              </span>
            </button>
          );
        })}
        {hits.length === 0 && query.trim() && <p className="none">Nothing said matches</p>}
      </div>
    </div>
  );
}
