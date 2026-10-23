// The conversation: what the user sent, the replies, the tools they used and notes on how
// turns ended, under the conversations that came before.

import {
  ArrowDown,
  Check,
  ChevronRight,
  CircleAlert,
  Globe,
  LoaderCircle,
  NotebookPen,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { imageUrl } from "./api.ts";
import { arrange, type Chat, type Item, type Shown, type ToolItem, thinking } from "./chat.ts";
import { useHighlight } from "./highlight.ts";
import { renderMarkdown, showImage } from "./markdown.ts";
import { viewImage } from "./viewer.tsx";

/** What the past above can ask of the timeline it is in. */
export interface Place {
  /** Called before more appear above, so the view stays where it is. */
  keepBottom(): void;
  /** Bring this to the top of the view, and stay there as it opens. */
  reveal(el: HTMLElement): void;
}

/**
 * The window's one scroller: what came before (`history`), then the conversation going on now,
 * if any. One taken up (`fill`) fills at least the whole view, so the past is out of sight until
 * the user scrolls up to it; one begun here, or none yet, grows from the end of the past, in
 * view above it. Far up, a button goes back down.
 */
export function Timeline(props: {
  history(place: Place): ReactNode;
  chat: Chat | undefined;
  /** Fill the view with the conversation going on (see above). */
  fill: boolean;
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
  const parts = chat ? arrange(chat.items, chat.running !== undefined) : [];
  return (
    <div className="transcript" ref={box} onScroll={onScroll}>
      <div className="column" ref={column}>
        {props.history(place)}
        <div
          key={id ?? ""}
          className={`now${props.fill ? " fill" : ""}${shown.arrived ? " arrived" : ""}`}
        >
          {chat &&
            parts.map((s) => (
              // Items are only appended (a tool's result fills its own), so where each starts
              // is stable.
              <ShownView key={s.at} shown={s} sessionId={chat.id} fresh={s.at >= opened} />
            ))}
          {chat?.streaming && (
            <Markdown className="assistant streaming fresh" text={chat.streaming} />
          )}
          {chat && thinking(chat) && <Thinking />}
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

/** An item, or the marks under Ivy's reply (see arrange). */
export function ShownView({
  shown,
  sessionId,
  fresh,
}: {
  shown: Shown;
  sessionId: string;
  fresh: boolean;
}) {
  if ("item" in shown) return <ItemView item={shown.item} sessionId={sessionId} fresh={fresh} />;
  return <Marks sources={shown.sources} aside={shown.aside} fresh={fresh} />;
}

/**
 * Under Ivy's reply, two quiet marks that open on a click, one at a time: where her words
 * came from (what she looked up and read), and what she did for herself (a memory saved, her
 * journal written; the journal only as written). There to see, not in the way of the talk.
 */
const MARKS = { sources: "Where this came from", aside: "From her own records" } as const;

function Marks({
  sources,
  aside,
  fresh,
}: {
  sources: ToolItem[];
  aside: ToolItem[];
  fresh: boolean;
}) {
  const [open, setOpen] = useState<keyof typeof MARKS>();
  const calls = useId();
  const plugins = (tools: ToolItem[]) => [...new Set(tools.map((t) => t.label.plugin))].join(" · ");
  const mark = (which: keyof typeof MARKS, tools: ToolItem[], icon: ReactNode) =>
    tools.length > 0 && (
      <button
        type="button"
        className={open === which ? "open" : ""}
        title={MARKS[which]}
        aria-label={`${MARKS[which]}: ${plugins(tools)}`}
        aria-expanded={open === which}
        aria-controls={open === which ? calls : undefined}
        onClick={() => setOpen(open === which ? undefined : which)}
      >
        {icon}
        {plugins(tools)}
      </button>
    );
  const shown = open === "sources" ? sources : open === "aside" ? aside : [];
  return (
    <div className={`marks${fresh ? " fresh" : ""}`}>
      <div className="chips">
        {mark("sources", sources, <Globe size={13} />)}
        {mark("aside", aside, <NotebookPen size={13} />)}
      </div>
      {open && shown.length > 0 && (
        // A group, not a region: a long talk with marks open shouldn't fill the landmarks.
        // biome-ignore lint/a11y/useSemanticElements: a fieldset is for form controls
        <div key={open} id={calls} className="calls" role="group" aria-label={MARKS[open]}>
          {shown.map((t) =>
            t.label.own === "journal" ? (
              <div key={t.id} className="private">
                <span className="plugin">{t.label.plugin}</span> an entry, hers to keep
              </div>
            ) : (
              <div key={t.id} className="call">
                <ToolCard item={t} fresh={false} />
                {/* Her own records, but what they gave back came from outside. */}
                {t.outside && t.label.own && (
                  <div className="provenance">
                    Part of what this found came from outside content
                  </div>
                )}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

export function ItemView({
  item,
  sessionId,
  fresh,
}: {
  item: Item;
  /** Whose transcript it is: where its images are. */
  sessionId: string;
  fresh: boolean;
}) {
  const f = fresh ? " fresh" : "";
  switch (item.kind) {
    case "user":
      return (
        <>
          {item.images && (
            <div className={`sent-images${f}`}>
              {item.images.map((name) => (
                <button
                  key={name}
                  type="button"
                  title="View"
                  onClick={() => viewImage(imageUrl(sessionId, name))}
                >
                  <img src={imageUrl(sessionId, name)} alt="" />
                </button>
              ))}
            </div>
          )}
          {item.text && <div className={`user${f}`}>{item.text}</div>}
        </>
      );
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
  // Bumped when an image is shown, to render it in.
  const [shown, setShown] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: rendered again once highlighting loads or an image is shown
  const html = useMemo(() => renderMarkdown(text), [text, highlighted, shown]);
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const shownImage = (e.target as Element).closest<HTMLImageElement>(".reply-image");
    if (shownImage) {
      viewImage(shownImage.src);
      return;
    }
    const image = (e.target as Element).closest<HTMLElement>(".show-image");
    if (image?.dataset.src) {
      showImage(image.dataset.src);
      setShown((n) => n + 1);
      return;
    }
    const copy = (e.target as Element).closest(".copy");
    const code = copy?.closest(".code")?.querySelector("pre")?.textContent;
    if (!copy || code == null) return;
    void navigator.clipboard.writeText(code).then(() => {
      copy.classList.add("done");
      setTimeout(() => copy.classList.remove("done"), 1200);
    });
  };
  return (
    // The copy and show-image buttons are real buttons inside; the div only delegates their
    // clicks.
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

function ToolCard({ item, fresh }: { item: ToolItem; fresh: boolean }) {
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
