// The chat window: one long conversation with Ivy, the past ones above the one going on now,
// her at the top, and her card hanging from her when she is clicked. Like the TUI it is a client of
// the daemon, which runs the sessions; this page only shows them and sends what the user types.
// The session going on is in the URL's hash, so a reload keeps it. While a past one is open,
// what is written goes to it, and it becomes the one going on.

import type { DaemonState, SessionEvent, SessionSummary } from "@ivy/protocol";
import {
  CircleAlert,
  CornerDownRight,
  LoaderCircle,
  Search as SearchIcon,
  SquarePen,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, follow } from "./api.ts";
import { apply, type Chat, chatOf, emptyChat } from "./chat.ts";
import { Composer, Permission, Queue } from "./composer.tsx";
import { History } from "./history.tsx";
import { greeting, presence } from "./presence.ts";
import { Card, Contact, Portrait } from "./profile.tsx";
import { Search } from "./search.tsx";
import { dayLabel, isRecent, timeLabel } from "./sessions.ts";
import { Timeline } from "./transcript.tsx";

const sessionInHash = () => decodeURIComponent(location.hash.slice(1)) || undefined;

/** Session events that change the list: a session started, ran, or finished a turn. */
const LISTED = new Set<SessionEvent["type"]>(["prompt", "turn_start", "turn_end"]);

export function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  /** The chat shown; undefined: a new one, not yet started. */
  const [chat, setChat] = useState<Chat | undefined>();
  const chatId = useRef<string | undefined>(undefined);
  const [state, setState] = useState<DaemonState | undefined>();
  const [connected, setConnected] = useState(true);
  const [error, setError] = useState<string | undefined>();
  /** The past conversation opened above, if any; its chat once read. */
  const [reading, setReading] = useState<{ id: string; chat?: Chat } | undefined>();
  const readingId = useRef<string | undefined>(undefined);
  /** Set, a new object each time, to bring the one open into view. */
  const [jump, setJump] = useState<object | undefined>();
  /** Set, a new number each time, to go back to the end of the conversation going on. */
  const [toEnd, setToEnd] = useState<number | undefined>();

  const failed = useCallback((err: unknown) => {
    setError(err instanceof Error ? err.message : String(err));
  }, []);

  const show = useCallback(
    async (id: string | undefined) => {
      chatId.current = id;
      setError(undefined);
      if (!id) {
        setChat(undefined);
        return;
      }
      try {
        const view = await api.session(id);
        if (chatId.current === id) setChat(chatOf(view));
      } catch (err) {
        if (chatId.current === id) setChat(undefined);
        failed(err);
      }
    },
    [failed],
  );

  /** Open a past conversation (or close it, with none), reading it afresh: it may have gone on. */
  const read = useCallback(
    (id: string | undefined) => {
      readingId.current = id;
      setReading(id ? { id } : undefined);
      if (!id) return;
      api.session(id).then((view) => {
        if (readingId.current === id) setReading({ id, chat: chatOf(view) });
      }, failed);
    },
    [failed],
  );

  const reloadList = useCallback(() => {
    api.sessions().then(setSessions, failed);
  }, [failed]);

  // Follow the daemon. On every (re)connect, read everything afresh: events may have been
  // missed while the stream was down.
  useEffect(() => {
    const stop = new AbortController();
    const onEvent = (e: SessionEvent) => {
      if (e.sessionId === chatId.current) {
        setChat((c) => (c && c.id === e.sessionId ? apply(c, e) : c));
      }
      if (e.sessionId === readingId.current) {
        setReading((r) => (r?.chat && r.id === e.sessionId ? { ...r, chat: apply(r.chat, e) } : r));
      }
      if (LISTED.has(e.type)) reloadList();
    };
    // Opening the window carries on a conversation from the last few hours; after longer, it
    // starts a new one, and that one is history.
    let first = true;
    const onConnect = (up: boolean) => {
      setConnected(up);
      if (!up) return;
      const carryOn = first && !chatId.current && !sessionInHash();
      first = false;
      api.sessions().then((list) => {
        setSessions(list);
        const last = list[0];
        if (carryOn && !chatId.current && last && isRecent(last)) {
          location.hash = encodeURIComponent(last.id);
        }
      }, failed);
      api.state().then(setState, failed);
      void show(chatId.current ?? sessionInHash());
      if (readingId.current) read(readingId.current);
    };
    void follow(onEvent, onConnect, stop.signal);
    const onHash = () => {
      if (sessionInHash() !== chatId.current) void show(sessionInHash());
    };
    addEventListener("hashchange", onHash);
    return () => {
      stop.abort();
      removeEventListener("hashchange", onHash);
    };
  }, [show, read, reloadList, failed]);

  const open = useCallback(
    (id: string | undefined) => {
      read(undefined);
      location.hash = id ? encodeURIComponent(id) : "";
      if (!id) void show(undefined); // an empty hash may not fire hashchange
    },
    [read, show],
  );

  /** Close the past conversation open above and go back down to the one going on. */
  const back = useCallback(() => {
    read(undefined);
    setToEnd((n) => (n ?? 0) + 1);
  }, [read]);

  /** Carry on the past conversation open above: what was read of it shows at once. */
  const carryOn = (id: string) => {
    const known = reading?.id === id ? reading.chat : undefined;
    if (known) {
      chatId.current = id; // so the hash changing doesn't read it again
      setChat(known);
      setError(undefined);
    }
    open(id);
  };

  // Her card, hanging from her at the top; the search for a past conversation (⌘K).
  const [card, setCard] = useState(false);
  const [searching, setSearching] = useState(false);
  const closeCard = useCallback(() => setCard(false), []);
  const closeSearch = useCallback(() => setSearching(false), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const plain = e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey;
      if (e.key === "Escape" && !e.defaultPrevented) {
        // Her card closes first, then the past conversation open above.
        if (card) setCard(false);
        else if (readingId.current) back();
      }
      // ⌘N: a new conversation, as the button at the top right.
      else if (plain && e.key === "n") {
        e.preventDefault();
        open(undefined);
      }
      // ⌘K: find a past conversation, as the button beside it.
      else if (plain && e.key === "k") {
        e.preventDefault();
        setCard(false);
        setSearching((v) => !v);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [card, back, open]);

  /** Go to a past conversation found, open above to carry on. */
  const pick = (id: string) => {
    if (readingId.current !== id) read(id);
    setJump({});
  };

  const send = async (text: string) => {
    setError(undefined);
    try {
      if (reading) {
        const id = reading.id;
        carryOn(id);
        await api.send(id, text);
        return;
      }
      let id = chat?.id;
      if (!id) {
        id = await api.createSession();
        chatId.current = id;
        setChat(emptyChat(id));
        history.replaceState(null, "", `#${encodeURIComponent(id)}`);
      }
      await api.send(id, text);
    } catch (err) {
      failed(err);
      throw err; // the composer keeps the text
    }
  };

  const remove = async (id: string) => {
    try {
      await api.deleteSession(id);
      if (chatId.current === id) open(undefined);
      else if (readingId.current === id) read(undefined);
    } catch (err) {
      failed(err);
    }
    reloadList();
  };

  // What is written goes to the past conversation open above, if one is.
  const target = reading ? reading.chat : chat;
  const composer = (
    <Composer
      busy={target?.running !== undefined}
      replying={reading !== undefined}
      onSend={send}
      onStop={() => target && api.interrupt(target.id).catch(failed)}
    />
  );
  const readingSummary = reading && sessions.find((s) => s.id === reading.id);
  const errorBanner = error && (
    <div className="error-banner fresh" role="alert">
      <CircleAlert size={15} />
      <span>{error}</span>
      <button type="button" className="icon" title="Dismiss" onClick={() => setError(undefined)}>
        <X size={14} />
      </button>
    </div>
  );
  const now = presence(chat, sessions, connected);
  return (
    <div className="app">
      <main>
        <header className="topbar">
          <span className="side">
            {!connected && (
              <span className="status">
                <LoaderCircle size={13} className="spin" /> Reconnecting
              </span>
            )}
          </span>
          {/* Before a conversation starts, she is in the middle of the page instead. */}
          {chat || card ? (
            <Contact presence={now} open={card} onToggle={() => setCard(!card)} />
          ) : (
            <span />
          )}
          <span className="side end">
            <button
              type="button"
              className="icon find"
              title="Search conversations (⌘K)"
              aria-expanded={searching}
              onClick={() => setSearching(!searching)}
            >
              <SearchIcon size={17} />
            </button>
            <button
              type="button"
              className="icon new"
              title="New chat (⌘N)"
              onClick={() => open(undefined)}
            >
              <SquarePen size={17} />
            </button>
          </span>
        </header>
        {card && (
          <Card
            presence={now}
            facts={{
              tokens: chat && chat.tokens.in + chat.tokens.out > 0 ? chat.tokens : undefined,
            }}
            state={state}
            onState={setState}
            onError={failed}
            onClose={closeCard}
          />
        )}
        {searching && (
          <Search
            sessions={sessions.filter((s) => s.id !== chat?.id)}
            onPick={pick}
            onClose={closeSearch}
          />
        )}
        <Timeline
          key={chat?.id ?? ""}
          chat={chat}
          toEnd={toEnd}
          history={(place) => (
            <History
              sessions={sessions.filter((s) => s.id !== chat?.id)}
              place={place}
              reading={reading}
              jump={jump}
              onRead={read}
              onContinue={carryOn}
              onDelete={remove}
            />
          )}
          empty={
            <div className="hello">
              <button
                type="button"
                className="face"
                title="About Ivy"
                onClick={() => setCard(true)}
              >
                <Portrait size={72} presence={now} />
              </button>
              <h1>{greeting()}</h1>
              <p>What's on your mind?</p>
            </div>
          }
        />
        <div className="dock">
          {errorBanner}
          {chat?.permission && (
            <Permission
              ask={chat.permission}
              onAnswer={(choice) => {
                if (chat.permission) api.answer(chat.permission.id, choice).catch(failed);
              }}
            />
          )}
          {readingSummary && (
            <div className="replying fresh">
              <CornerDownRight size={14} />
              <span className="text">
                Replying to {when(readingSummary)}
                <span className="preview">{readingSummary.preview || "Untitled"}</span>
              </span>
              <button
                type="button"
                className="icon"
                title={chat ? "Back to this conversation (Esc)" : "Cancel (Esc)"}
                onClick={back}
              >
                <X size={14} />
              </button>
            </div>
          )}
          {chat && chat.queue.length > 0 && (
            <Queue
              queue={chat.queue}
              onWithdraw={(p) => api.withdraw(chat.id, p.id).catch(failed)}
            />
          )}
          {composer}
        </div>
      </main>
    </div>
  );
}

/** "Yesterday 9:05" */
function when(s: SessionSummary): string {
  const date = new Date(s.updatedAt);
  return `${dayLabel(date)} ${timeLabel(date)}`;
}
