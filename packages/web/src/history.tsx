// What came before: past conversations above the current one, oldest first, each the stretch of
// the talk it was, shown whole after when it began. Scrolling up through them reads like
// scrolling back through a long conversation with someone.

import type { SessionSummary } from "@ivy/protocol";
import { LoaderCircle, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import { arrange, type Chat, chatOf } from "./chat.ts";
import { type Found, lightUp, messageIn } from "./search.tsx";
import { when } from "./sessions.ts";
import { Divider, type Place, ShownView } from "./transcript.tsx";

/** Stretches as last read: one just left shows at once, above the next. */
const stretches = new Map<string, Chat>();

/** Keep what a conversation holds, as it ends a stretch, to show it above the next at once. */
export const keepStretch = (chat: Chat) => stretches.set(chat.id, chat);
/** Let go of what one held, deleted or ended: nothing of it stays in the window. */
export const forgetStretch = (id: string) => stretches.delete(id);

/** How many past conversations show at first, and how many more each "Earlier" brings. */
const PAGE = 20;
/** Room held for a stretch not read yet, by its turns, so the page doesn't jump much once it is. */
const unread = (turns: number) => Math.min(80 + turns * 120, 720);

export function History(props: {
  /** Newest first, as the daemon lists them; without the conversation going on now. */
  sessions: SessionSummary[];
  /** Where it is in the timeline. */
  place: Place;
  /** Set (a new object each time) to go to a message found, wherever it is. */
  jump: Found | undefined;
  onDelete(id: string): void;
}) {
  const { jump } = props;
  const [paged, setShown] = useState(PAGE);
  // One gone to from further back than the pages loaded shows too, with all after it.
  const needed = jump ? props.sessions.findIndex((s) => s.id === jump.id) + 1 : 0;
  const shown = Math.max(paged, needed);
  // One asked to confirm a delete, at a time.
  const [confirming, setConfirming] = useState<string | undefined>();
  const sessions = props.sessions.slice(0, shown).reverse();
  if (sessions.length === 0) return null;
  return (
    <div className="history">
      {props.sessions.length > shown && (
        <button
          type="button"
          className="earlier"
          onClick={() => {
            props.place.keepBottom();
            setShown(shown + PAGE);
          }}
        >
          Earlier conversations
        </button>
      )}
      {sessions.map((s, i) => (
        <Stretch
          key={s.id}
          session={s}
          when={when(s.createdAt, sessions[i - 1]?.createdAt)}
          jump={jump?.id === s.id ? jump : undefined}
          place={props.place}
          confirming={s.id === confirming}
          onConfirm={(yes) => setConfirming(yes ? s.id : undefined)}
          onDelete={props.onDelete}
        />
      ))}
    </div>
  );
}

/**
 * An earlier stretch of the talk, whole, after when it began: read once it nears the view (or is
 * gone to), and again when it has gone on.
 */
function Stretch(props: {
  session: SessionSummary;
  when: string;
  jump: Found | undefined;
  place: Place;
  confirming: boolean;
  onConfirm(yes: boolean): void;
  onDelete(id: string): void;
}) {
  const { session: s, jump, place } = props;
  const [chat, setChat] = useState(() => stretches.get(s.id));
  const self = useRef<HTMLDivElement>(null);
  // Near the view, within a screen of it: read only then, as most of the past is never
  // scrolled to.
  const [near, setNear] = useState(() => chat !== undefined || jump !== undefined);
  if (jump && !near) setNear(true);
  useEffect(() => {
    const el = self.current;
    if (near || !el) return;
    const watch = new IntersectionObserver(
      (seen) => seen.some((e) => e.isIntersecting) && setNear(true),
      {
        root: el.closest(".transcript"),
        rootMargin: "100% 0px",
      },
    );
    watch.observe(el);
    return () => watch.disconnect();
  }, [near]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when it has gone on
  useEffect(() => {
    if (!near) return;
    let shown = true;
    api.session(s.id).then(
      (view) => {
        const read = chatOf(view);
        stretches.set(s.id, read);
        if (!shown) return;
        // Growing above what is being read, it leaves the view where it is.
        if (self.current) place.keepIfAbove(self.current);
        setChat(read);
      },
      // Gone meanwhile (deleted, or off the record and ended): the list drops it next.
      () => forgetStretch(s.id),
    );
    return () => {
      shown = false;
    };
  }, [near, s.id, s.updatedAt]);
  // Gone to, and again once read, to the message found in it: what loads above it then keeps
  // it where it is.
  const read = chat !== undefined;
  useLayoutEffect(() => {
    const el = self.current;
    if (!jump || !el) return;
    const message = read ? messageIn(el, jump) : undefined;
    place.reveal(message ?? el);
    if (message) lightUp(message);
  }, [jump, place, read]);
  return (
    // Leaving it drops a pending confirm; the buttons inside take the keys.
    // biome-ignore lint/a11y/noStaticElementInteractions: see above
    <div
      ref={self}
      className={`stretch${props.confirming ? " confirming" : ""}`}
      onMouseLeave={() => props.confirming && props.onConfirm(false)}
    >
      <Divider when={props.when}>
        {!s.busy && (
          <Delete
            confirming={props.confirming}
            onConfirm={props.onConfirm}
            onDelete={() => props.onDelete(s.id)}
          />
        )}
      </Divider>
      {chat ? (
        arrange(chat.items).map((shown) => (
          <ShownView key={shown.at} shown={shown} sessionId={chat.id} fresh={false} />
        ))
      ) : (
        <div className="unread" style={{ height: unread(s.turns) }}>
          {near && <LoaderCircle size={16} className="spin loading" />}
        </div>
      )}
    </div>
  );
}

/** Deleting takes two clicks: the trash button, then the Delete it turns into. */
function Delete(props: { confirming: boolean; onConfirm(yes: boolean): void; onDelete(): void }) {
  return props.confirming ? (
    <button
      type="button"
      className="delete confirm"
      onClick={() => {
        props.onConfirm(false);
        props.onDelete();
      }}
      onKeyDown={(e) => e.key === "Escape" && props.onConfirm(false)}
    >
      Delete
    </button>
  ) : (
    <button type="button" className="delete" title="Delete" onClick={() => props.onConfirm(true)}>
      <Trash2 size={14} />
    </button>
  );
}
