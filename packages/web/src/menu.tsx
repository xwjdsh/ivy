// A quiet button in the composer that opens a menu above it. Not the system's select: in the
// app's web view its popup is a plain native menu that doesn't belong to the page.

import { Check, ChevronDown, Search } from "lucide-react";
import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export interface MenuOption {
  value: string;
  label: string;
  /** Options with a group come under its name; the options come grouped. */
  group?: string;
  /** A word on the right, in grey. */
  detail?: string;
  icon?: ReactNode;
}

export function Pick(props: {
  value: string;
  /** What the button shows: the chosen option's label, or this. */
  shown?: ReactNode;
  title: string;
  disabled?: boolean;
  options: MenuOption[];
  /** A box at the top that narrows the options, for a long list. */
  search?: string;
  /** Open below the button; above it by default (the composer sits at the window's bottom). */
  below?: boolean;
  className?: string;
  onChange(value: string): void;
}) {
  const { open, setOpen, box, close } = useMenuBox();
  const chosen = props.options.find((o) => o.value === props.value);
  return (
    <div className={`pick-box ${props.className ?? ""}`} ref={box}>
      <button
        type="button"
        className={`pick${open ? " open" : ""}`}
        title={props.title}
        disabled={props.disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {props.shown ?? (
          <>
            {chosen?.icon}
            <span className="text">{chosen?.label ?? props.value}</span>
          </>
        )}
        {!props.disabled && <ChevronDown size={13} className="caret" />}
      </button>
      {open && (
        <Menu
          value={props.value}
          options={props.options}
          search={props.search}
          below={props.below}
          onChoose={(v) => {
            close();
            if (v !== props.value) props.onChange(v);
          }}
          onClose={close}
        />
      )}
    </div>
  );
}

/** Several options at once: each pick turns one on or off, and the menu stays open. The ones
 * chosen when it opens come first; they stay where they are while it is open. */
export function PickMany(props: {
  values: string[];
  /** What the button shows. */
  shown: ReactNode;
  title: string;
  options: MenuOption[];
  search?: string;
  below?: boolean;
  className?: string;
  onChange(values: string[]): void;
}) {
  const { open, setOpen, box, close } = useMenuBox();
  const [first, setFirst] = useState<string[]>([]);
  const options = [
    ...props.options
      .filter((o) => first.includes(o.value))
      .map((o) => ({ ...o, group: "Chosen", detail: o.detail ?? o.group })),
    ...props.options
      .filter((o) => !first.includes(o.value))
      .map((o) => ({ ...o, group: o.group || (first.length ? "More" : undefined) })),
  ];
  return (
    <div className={`pick-box ${props.className ?? ""}`} ref={box}>
      <button
        type="button"
        className={`pick${open ? " open" : ""}`}
        title={props.title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (!open) setFirst(props.values);
          setOpen((o) => !o);
        }}
      >
        <span className="text">{props.shown}</span>
        <ChevronDown size={13} className="caret" />
      </button>
      {open && (
        <Menu
          value={props.values[0] ?? ""}
          chosen={(v) => props.values.includes(v)}
          options={options}
          search={props.search}
          below={props.below}
          onChoose={(v) =>
            props.onChange(
              props.values.includes(v) ? props.values.filter((x) => x !== v) : [...props.values, v],
            )
          }
          onClose={close}
        />
      )}
    </div>
  );
}

/** A button's box and whether its menu is open; a click elsewhere closes it. */
function useMenuBox() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    addEventListener("pointerdown", away);
    return () => removeEventListener("pointerdown", away);
  }, [open]);
  const close = () => {
    setOpen(false);
    box.current?.querySelector<HTMLElement>(".pick")?.focus();
  };
  return { open, setOpen, box, close };
}

function Menu(props: {
  value: string;
  /** Which options are chosen; the one of `value` by default. */
  chosen?(value: string): boolean;
  options: MenuOption[];
  search?: string;
  below?: boolean;
  onChoose(value: string): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const shown = matching(props.options, query);
  const chosen = props.chosen ?? ((v: string) => v === props.value);
  // One option is lit, by the keys or the pointer; Enter takes it.
  const [lit, setLit] = useState(() => props.options.find((o) => o.value === props.value)?.value);
  const litAt = shown.findIndex((o) => o.value === lit);
  const list = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // The menu stays in the window: on its side if the list fits there or that side has more
  // room, on the other otherwise, and the list no taller than the room.
  const [below, setBelow] = useState(props.below ?? false);
  const [room, setRoom] = useState<number>();
  useLayoutEffect(() => {
    const button = menu.current?.parentElement?.getBoundingClientRect();
    if (!menu.current || !list.current || !button) return;
    const around = menu.current.offsetHeight - list.current.offsetHeight + MENU_GAP;
    const under = innerHeight - button.bottom - around;
    const over = button.top - around;
    const tallest = Number.parseFloat(getComputedStyle(list.current).maxHeight) || Infinity;
    const needs = Math.min(list.current.scrollHeight, tallest);
    const [mine, other] = props.below ? [under, over] : [over, under];
    const stay = mine >= needs || mine >= other;
    setBelow(stay === !!props.below);
    setRoom(Math.min(tallest, stay ? mine : other));
  }, [props.below]);
  useEffect(() => {
    // The page around stays where it is.
    (field.current ?? list.current)?.focus({ preventScroll: true });
  }, []);
  // Keep the lit option in sight; on opening, the chosen one in the middle.
  const opened = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when what is lit or shown changes
  useLayoutEffect(() => {
    const el = list.current?.querySelector<HTMLElement>("[data-lit]");
    if (list.current && el) {
      scrollWithin(list.current, el, { center: !opened.current, top: GROUP_HEIGHT });
    }
    opened.current = true;
  }, [lit, query]);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    // ↑↓, or Ctrl-P / Ctrl-N as in Emacs and the terminal.
    const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
    const move =
      e.key === "ArrowDown" || (ctrl && e.key === "n")
        ? 1
        : e.key === "ArrowUp" || (ctrl && e.key === "p")
          ? -1
          : 0;
    if (e.key === "Escape") {
      e.stopPropagation(); // not the composer's Escape, which stops a reply
      if (query) {
        setQuery("");
        setLit(props.value);
      } else props.onClose();
    } else if (move) {
      e.preventDefault();
      if (shown.length === 0) return;
      const at = litAt < 0 ? (move > 0 ? -1 : 0) : litAt;
      setLit(shown[(at + move + shown.length) % shown.length]?.value);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = shown[litAt] ?? shown[0];
      if (pick) props.onChoose(pick.value);
    } else if (e.key === "Tab") {
      props.onClose();
    }
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the keys light the options in the list
    <div
      ref={menu}
      className={`menu${props.search ? " wide" : ""}${below ? " below" : ""}`}
      onKeyDown={onKeyDown}
    >
      {props.search && (
        <label className="find">
          <Search size={14} />
          <input
            ref={field}
            value={query}
            placeholder={props.search}
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value);
              setLit(matching(props.options, e.target.value)[0]?.value);
            }}
          />
        </label>
      )}
      <div
        className="options"
        role="listbox"
        style={room === undefined ? undefined : { maxHeight: room }}
        aria-multiselectable={props.chosen ? true : undefined}
        tabIndex={-1}
        ref={list}
        // A pick leaves the keys where they were: in the search, choosing several.
        onMouseDown={(e) => field.current && e.preventDefault()}
        // Scrolled, a group's name stuck at the top lies over options: a line shows it does.
        onScroll={(e) => {
          e.currentTarget.toggleAttribute("data-scrolled", e.currentTarget.scrollTop > 0);
        }}
      >
        {shown.map((o, i) => (
          <Fragment key={o.value}>
            {o.group && o.group !== shown[i - 1]?.group && <div className="group">{o.group}</div>}
            {/* The list takes the keys for every option; see onKeyDown above. */}
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: see above */}
            <div
              role="option"
              tabIndex={-1}
              aria-selected={chosen(o.value)}
              data-lit={o.value === lit || undefined}
              onPointerMove={() => o.value !== lit && setLit(o.value)}
              onClick={() => props.onChoose(o.value)}
            >
              {o.icon}
              <span className="label">{o.label}</span>
              {o.detail && <span className="detail">{o.detail}</span>}
              <span className="mark">{chosen(o.value) && <Check size={14} />}</span>
            </div>
          </Fragment>
        ))}
        {shown.length === 0 && <div className="none">Nothing matches “{query}”</div>}
      </div>
    </div>
  );
}

/** The options whose group and label have every word of the query. */
function matching(options: MenuOption[], query: string): MenuOption[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return options.filter((o) => {
    const text = `${o.group ?? ""} ${o.label}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** How hard the model thinks, as bars: level 1 of 5 lights one. */
export function Bars({ level, of }: { level: number; of: number }) {
  return (
    <svg className="bars" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      {Array.from({ length: of }, (_, i) => {
        const w = 12 / of;
        const h = 3 + (8 * i) / Math.max(1, of - 1);
        return (
          <rect
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed bars
            key={i}
            x={1 + i * w + 0.5}
            y={12.5 - h}
            width={w - 1}
            height={h}
            rx={0.6}
            className={i < level ? "on" : undefined}
          />
        );
      })}
    </svg>
  );
}

/** Between a menu and the window's edge, and its button. */
const MENU_GAP = 20;

/** What a group's name, stuck at the top of a list, covers of it. */
const GROUP_HEIGHT = 28;

/**
 * Scroll `list` alone so that `el` is in sight (or in its middle), never what holds the list:
 * scrollIntoView would move every scrolling box around it, the page included.
 */
export function scrollWithin(
  list: HTMLElement,
  el: HTMLElement,
  opts: { center?: boolean; top?: number } = {},
): void {
  const box = list.getBoundingClientRect();
  const at = el.getBoundingClientRect();
  const top = box.top + (opts.top ?? 0);
  if (opts.center) {
    list.scrollTop += at.top + at.height / 2 - (box.top + box.height / 2);
  } else if (at.top < top) {
    list.scrollTop -= top - at.top;
  } else if (at.bottom > box.bottom) {
    list.scrollTop += at.bottom - box.bottom;
  }
}
