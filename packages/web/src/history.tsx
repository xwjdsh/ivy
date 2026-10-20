// What came before: past conversations above the current one, oldest first, under the day
// they happened, each folded to a line until opened. Scrolling up through them reads like
// scrolling back through a long conversation with someone.

import type { SessionSummary } from "@ivy/protocol";
import { ChevronDown, LoaderCircle, Trash2 } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { Chat } from "./chat.ts";
import { byDay, timeLabel } from "./sessions.ts";
import { ItemView, type Place } from "./transcript.tsx";

/** How many past conversations show at first, and how many more each "Earlier" brings. */
const PAGE = 20;

export function History(props: {
  /** Newest first, as the daemon lists them; without the conversation going on now. */
  sessions: SessionSummary[];
  /** Where it is in the timeline. */
  place: Place;
  /** The one opened, if any, and what it holds once read. */
  reading: { id: string; chat?: Chat } | undefined;
  /** Set (a new object each time) to go to the one opened, wherever it is. */
  jump: object | undefined;
  onRead(id: string | undefined): void;
  onContinue(id: string): void;
  onDelete(id: string): void;
}) {
  const { reading } = props;
  const [paged, setShown] = useState(PAGE);
  // One gone to from further back than the pages loaded shows too, with all after it.
  const needed = reading ? props.sessions.findIndex((s) => s.id === reading.id) + 1 : 0;
  const shown = Math.max(paged, needed);
  // Deleting takes two clicks: the trash button, then the Delete it turns into.
  const [confirming, setConfirming] = useState<string | undefined>();
  const sessions = props.sessions.slice(0, shown);
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
      {byDay(sessions).map((day) => (
        <section key={day.label} className="day">
          <h2>{day.label}</h2>
          {day.sessions.map((s) => (
            <Past
              key={s.id}
              session={s}
              open={reading?.id === s.id}
              chat={reading?.id === s.id ? reading.chat : undefined}
              jump={reading?.id === s.id ? props.jump : undefined}
              place={props.place}
              confirming={s.id === confirming}
              onConfirm={(yes) => setConfirming(yes ? s.id : undefined)}
              onRead={props.onRead}
              onContinue={props.onContinue}
              onDelete={props.onDelete}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

/**
 * One past conversation: a line with when and how it began; opened, all of it. One is open at a
 * time, and what is written while it is goes to it.
 */
function Past(props: {
  session: SessionSummary;
  open: boolean;
  chat: Chat | undefined;
  jump: object | undefined;
  place: Place;
  confirming: boolean;
  onConfirm(yes: boolean): void;
  onRead(id: string | undefined): void;
  onContinue(id: string): void;
  onDelete(id: string): void;
}) {
  const { session: s, open, chat, confirming, jump, place } = props;
  const toggle = () => props.onRead(open ? undefined : s.id);
  const line = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (jump && line.current) place.reveal(line.current);
  }, [jump, place]);
  return (
    // Leaving the line drops a pending confirm; the buttons inside take the keys.
    // biome-ignore lint/a11y/noStaticElementInteractions: see above
    <div
      ref={line}
      className={`past${open ? " open" : ""}${confirming ? " confirming" : ""}`}
      onMouseLeave={() => confirming && props.onConfirm(false)}
    >
      <div className="past-head">
        <button type="button" className="past-row" aria-expanded={open} onClick={toggle}>
          <span className="time">{timeLabel(new Date(s.updatedAt))}</span>
          <span className="preview">{s.preview || "Untitled"}</span>
          {s.busy && <span className="busy" title="Replying" />}
          <ChevronDown size={14} className="fold" />
        </button>
        {/* A conversation Ivy is replying in can't be deleted; stop it first. */}
        {!s.busy &&
          (confirming ? (
            <button
              type="button"
              className="delete confirm"
              onClick={() => {
                props.onConfirm(false);
                props.onDelete(s.id);
              }}
              onKeyDown={(e) => e.key === "Escape" && props.onConfirm(false)}
            >
              Delete
            </button>
          ) : (
            <button
              type="button"
              className="delete"
              title="Delete"
              onClick={() => props.onConfirm(true)}
            >
              <Trash2 size={14} />
            </button>
          ))}
      </div>
      {open && (
        <div className="past-body">
          {chat ? (
            chat.items.map((item, i) => (
              // A past conversation is read once, whole; the index is stable.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              <ItemView key={i} item={item} fresh={false} />
            ))
          ) : (
            <LoaderCircle size={16} className="spin loading" />
          )}
          <button type="button" className="continue" onClick={() => props.onContinue(s.id)}>
            Continue this conversation
          </button>
        </div>
      )}
    </div>
  );
}
