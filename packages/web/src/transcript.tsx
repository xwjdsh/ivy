// The conversation: what the user sent, the replies, the tools they used and notes on how
// turns ended, under the conversations that came before.

import {
  ArrowDown,
  Check,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Chat, Item } from "./chat.ts";
import { useHighlight } from "./highlight.ts";
import { renderMarkdown } from "./markdown.ts";

/** What the past above can ask of the timeline it is in. */
export interface Place {
  /** Called before more appear above, so the view stays where it is. */
  keepBottom(): void;
  /** Bring this to the top of the view, and stay there as it opens. */
  reveal(el: HTMLElement): void;
}

/**
 * The window's one scroller: what came before (`history`), then the conversation going on now,
 * or `empty` before one starts. The current conversation fills at least the whole view, so the
 * past is out of sight until the user scrolls up to it; far up, a button goes back down.
 */
export function Timeline(props: {
  history(place: Place): ReactNode;
  chat: Chat | undefined;
  empty: ReactNode;
  /** Changes when the view should go back to the end of the conversation going on. */
  toEnd: unknown;
}) {
  const { chat } = props;
  const id = chat?.id;
  const box = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  // Follow the end of the conversation as it grows, unless the user scrolled up to read.
  const pinned = useRef(true);
  // Set when what is about to grow is above the view: keep this distance from the bottom.
  const fromBottom = useRef<number | undefined>(undefined);
  const follow = useCallback(() => {
    const el = box.current;
    if (!el) return;
    if (pinned.current) el.scrollTop = el.scrollHeight;
    else if (fromBottom.current !== undefined) el.scrollTop = el.scrollHeight - fromBottom.current;
    fromBottom.current = undefined;
  }, []);
  // Another conversation shown: go to its end. The past above stays as it was.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the conversation changes
  useLayoutEffect(() => {
    pinned.current = true;
  }, [id]);
  useLayoutEffect(follow);
  // A past conversation opening, or loading more of them, changes the height without this
  // rendering again; a resize observer still runs before the frame is painted.
  useLayoutEffect(() => {
    const el = column.current;
    if (!el) return;
    const watch = new ResizeObserver(follow);
    watch.observe(el);
    return () => watch.disconnect();
  }, [follow]);
  // Scrolled up more than half a view from the end: offer the way back.
  const [away, setAway] = useState(false);
  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    const below = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinned.current = below < 40;
    setAway(below > el.clientHeight / 2);
  };
  const end = useCallback(() => {
    const el = box.current;
    if (!el) return;
    pinned.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);
  useEffect(() => {
    if (props.toEnd !== undefined) end();
  }, [props.toEnd, end]);
  const place = useMemo<Place>(
    () => ({
      keepBottom: () => {
        const el = box.current;
        if (el) fromBottom.current = el.scrollHeight - el.scrollTop;
      },
      reveal: (target) => {
        // Unpinned first: what opens below it must not pull the view back to the end.
        pinned.current = false;
        fromBottom.current = undefined;
        target.scrollIntoView({ block: "start" });
      },
    }),
    [],
  );
  // What the conversation had when shown appears at once; what comes after fades in. Shown in
  // place of another that had something, it arrives as a whole.
  const [shown, setShown] = useState({ id, opened: chat?.items.length ?? 0, arrived: false });
  if (shown.id !== id) {
    setShown({ id, opened: chat?.items.length ?? 0, arrived: (chat?.items.length ?? 0) > 0 });
  }
  const { opened } = shown;
  const thinking =
    chat?.running !== undefined &&
    !chat.streaming &&
    !chat.permission &&
    !chat.items.some((i) => i.kind === "tool" && i.running);
  return (
    <div className="transcript" ref={box} onScroll={onScroll}>
      <div className="column" ref={column}>
        {props.history(place)}
        <div key={id ?? ""} className={`now${shown.arrived ? " arrived" : ""}`}>
          {chat
            ? chat.items.map((item, i) => (
                // Items are only appended (a tool's result fills its own), so the index is
                // stable.
                // biome-ignore lint/suspicious/noArrayIndexKey: see above
                <ItemView key={i} item={item} fresh={i >= opened} />
              ))
            : props.empty}
          {chat?.streaming && (
            <Markdown className="assistant streaming fresh" text={chat.streaming} />
          )}
          {thinking && <Thinking />}
        </div>
        {away && (
          <div className="to-end">
            <button type="button" title="Back to the end" onClick={end}>
              <ArrowDown size={16} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function ItemView({ item, fresh }: { item: Item; fresh: boolean }) {
  const f = fresh ? " fresh" : "";
  switch (item.kind) {
    case "user":
      return <div className={`user${f}`}>{item.text}</div>;
    case "assistant":
      return <Markdown className={`assistant${f}`} text={item.markdown} />;
    case "tool":
      return <ToolCard item={item} fresh={fresh} />;
    case "note":
      return (
        <div className={`note ${item.tone}${f}`}>
          {item.tone === "error" ? <CircleAlert size={14} /> : <TriangleAlert size={14} />}
          {item.text}
        </div>
      );
  }
}

function Markdown({ text, className }: { text: string; className: string }) {
  const highlighted = useHighlight();
  // biome-ignore lint/correctness/useExhaustiveDependencies: rendered again once highlighting loads
  const html = useMemo(() => renderMarkdown(text), [text, highlighted]);
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const copy = (e.target as Element).closest(".copy");
    const code = copy?.closest(".code")?.querySelector("pre")?.textContent;
    if (!copy || code == null) return;
    void navigator.clipboard.writeText(code).then(() => {
      copy.classList.add("done");
      setTimeout(() => copy.classList.remove("done"), 1200);
    });
  };
  return (
    // The copy buttons are real buttons inside; the div only delegates their clicks.
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: see above
    <div
      className={className}
      onClick={onClick}
      // renderMarkdown escapes what the model wrote; see markdown.ts.
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized above
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function ToolCard({ item, fresh }: { item: Extract<Item, { kind: "tool" }>; fresh: boolean }) {
  const state = item.running ? "running" : item.isError ? "failed" : "done";
  const icon = item.running ? (
    <LoaderCircle size={14} className="spin" />
  ) : item.isError ? (
    <X size={14} />
  ) : (
    <Check size={14} />
  );
  return (
    <details className={`tool ${state}${fresh ? " fresh" : ""}`}>
      <summary>
        <span className="status">{icon}</span>
        <span className="plugin">{item.label.plugin}</span>
        <span className="what">{item.label.text}</span>
        <ChevronRight size={14} className="chevron" />
      </summary>
      <div className="io">
        <div className="label">Input</div>
        <pre>{JSON.stringify(item.input, null, 2)}</pre>
        {item.result && (
          <>
            <div className="label">{item.isError ? "Error" : "Result"}</div>
            <pre>{item.result}</pre>
          </>
        )}
      </div>
    </details>
  );
}

function Thinking() {
  return (
    <div className="thinking fresh">
      <span className="dots">
        <i />
        <i />
        <i />
      </span>
      Thinking
    </div>
  );
}
