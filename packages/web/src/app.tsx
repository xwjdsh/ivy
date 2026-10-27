// The chat window: one long conversation with Ivy, the past ones above the one going on now,
// her at the top, and her card growing out of her face when she is clicked. Like the TUI it is a client of
// the daemon, which runs the sessions; this page only shows them and sends what the user types.
// The session going on is in the URL's hash, so a reload keeps it. While a past one is open,
// what is written goes to it, and it becomes the one going on.

import type { DaemonState, SessionEvent, SessionSummary } from "@ivy/protocol";
import {
  ChevronLeft,
  CircleAlert,
  CornerDownRight,
  LoaderCircle,
  Search as SearchIcon,
  Settings as SettingsIcon,
  SquarePen,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, follow } from "./api.ts";
import { apply, type Chat, chatOf, emptyChat } from "./chat.ts";
import { Composer, Permission, Queue } from "./composer.tsx";
import { History } from "./history.tsx";
import { presence } from "./presence.ts";
import { Card, Contact } from "./profile.tsx";
import { Search } from "./search.tsx";
import { dayLabel, isRecent, timeLabel } from "./sessions.ts";
import { SettingsPage } from "./settings.tsx";
import { Timeline } from "./transcript.tsx";
import { ImageViewer } from "./viewer.tsx";

const sessionInHash = () => decodeURIComponent(location.hash.slice(1)) || undefined;

/** Session events that change the list: a session started, ran, or finished a turn. */
const LISTED = new Set<SessionEvent["type"]>(["prompt", "turn_start", "turn_end"]);

export function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  /** The chat shown; undefined: a new one, not yet started. */
  const [chat, setChat] = useState<Chat | undefined>();
  /** The conversation about to start goes off the record (switched on her card). */
  const [offNext, setOffNext] = useState(false);
  /** Whether the conversation going on is off the record, for a new one started from it. */
  const offNow = useRef(false);
  offNow.current = chat?.offRecord === true;
  const chatId = useRef<string | undefined>(undefined);
  /**
   * Conversations begun in this window: one grows from the end of the past, which stays in view
   * above it, rather than filling the view at once as one taken up does.
   */
  const startedHere = useRef(new Set<string>());
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
      // A new one started from one off the record stays so (kept by mistake can't be undone;
      // the switch turns it off); any other starts on the record. Nothing is saved.
      if (id) setOffNext(false);
      else setOffNext((on) => on || offNow.current);
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

  // Her card; the search for a past conversation (⌘K); the settings (⌘,), over the
  // conversation, which stays as it was under them.
  // Her card grows out of her face at the top and goes back into it before it is gone: the
  // face itself, an element, is what it needs.
  const [card, setCard] = useState<{ from: HTMLElement; closing: boolean } | null>(null);
  const [searching, setSearching] = useState(false);
  const [settings, setSettings] = useState(false);
  // Whether the memory plugin, on, has what she remembers to show on her card.
  const [remembers, setRemembers] = useState(false);
  useEffect(() => {
    if (!connected) return;
    api
      .commands()
      // Only a row on her card hangs on it: none, rather than an alarm.
      .then((list) => setRemembers(list.some((c) => c.name === "/remembered")))
      .catch(() => setRemembers(false));
  }, [connected]);
  const openSettings = useCallback((open: boolean) => {
    setCard(null);
    setSearching(false);
    setSettings(open);
  }, []);
  // The app's menu (Ivy → Settings…, ⌘,) asks for them: by an event, or, if it came before
  // this page listened, by a flag left on the window (app/window.go).
  useEffect(() => {
    const wanted = () => {
      const w = window as { ivyWantsSettings?: boolean };
      if (!w.ivyWantsSettings) return;
      w.ivyWantsSettings = false;
      openSettings(true);
    };
    wanted();
    addEventListener("ivy:settings", wanted);
    return () => removeEventListener("ivy:settings", wanted);
  }, [openSettings]);
  const closeCard = useCallback(
    () => setCard((c) => (c && !c.closing ? { ...c, closing: true } : c)),
    [],
  );
  const cardClosed = useCallback(() => setCard(null), []);
  const toggleCard = (e: { currentTarget: HTMLElement }) =>
    card && !card.closing ? closeCard() : setCard({ from: e.currentTarget, closing: false });
  const closeSearch = useCallback(() => setSearching(false), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const plain = e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey;
      if (e.key === "Escape" && !e.defaultPrevented) {
        // Her card closes first, then the settings, then the past conversation open above.
        if (card && !card.closing) closeCard();
        else if (settings) setSettings(false);
        else if (readingId.current) back();
      }
      // ⌘,: the settings, as in every Mac app.
      else if (plain && e.key === ",") {
        e.preventDefault();
        openSettings(!settings);
      }
      // ⌘N: a new conversation, as the button at the top right.
      else if (plain && e.key === "n") {
        e.preventDefault();
        open(undefined);
      }
      // ⌘K: find a past conversation, as the button beside it.
      else if (plain && e.key === "k") {
        e.preventDefault();
        setCard(null);
        setSearching((v) => !v);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [card, closeCard, settings, openSettings, back, open]);

  /** Go to a past conversation found, open above to carry on. */
  const pick = (id: string) => {
    setSettings(false); // to be seen
    if (readingId.current !== id) read(id);
    setJump({});
  };

  const send = async (text: string, images: string[]) => {
    setError(undefined);
    try {
      if (reading) {
        const id = reading.id;
        carryOn(id);
        await api.send(id, text, images);
        return;
      }
      let id = chat?.id;
      if (!id) {
        id = await api.createSession(offNext);
        startedHere.current.add(id);
        chatId.current = id;
        setChat(emptyChat(id, offNext));
        setOffNext(false);
        history.replaceState(null, "", `#${encodeURIComponent(id)}`);
      }
      await api.send(id, text, images);
    } catch (err) {
      // Off the record and left idle, it ended and was deleted, as the user was told: start
      // afresh, with what they wrote still in the composer.
      const ended =
        chat?.offRecord && err instanceof Error && err.message.startsWith("Session not found");
      if (ended) {
        open(undefined); // off the record still, as the user chose
        setError(
          "That conversation was off the record and has ended, so it's gone. Send again to start a new one.",
        );
      } else {
        failed(err);
      }
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
  // Off the record is decided as a conversation starts, for all of it (DESIGN.md §11, M3).
  const offRecord = chat ? chat.offRecord === true : offNext;
  const composer = (
    <Composer
      busy={target?.running !== undefined}
      replying={reading !== undefined}
      noModel={state?.model === ""}
      offRecord={offRecord && !reading}
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
  // A new install: no model until a provider is added and one chosen.
  const setup = state?.model === "" && !settings && (
    <div className="setup-banner fresh">
      <span>Ivy needs a model to talk with you: add a provider and choose one.</span>
      <button type="button" className="primary" onClick={() => openSettings(true)}>
        Open Settings
      </button>
    </div>
  );
  const now = presence(chat, sessions, connected, offRecord);
  return (
    <div className="app">
      <main>
        <header className="topbar">
          <span className="side">
            {settings && (
              <button
                type="button"
                className="back"
                title="Back to Ivy (Esc)"
                onClick={() => openSettings(false)}
              >
                <ChevronLeft size={16} />
                Settings
              </button>
            )}
            {!connected && (
              <span className="status">
                <LoaderCircle size={13} className="spin" /> Reconnecting
              </span>
            )}
          </span>
          {/* Her, always, at the top; the settings are behind the scenes, without her. */}
          {!settings ? (
            <Contact presence={now} open={!!card && !card.closing} onToggle={toggleCard} />
          ) : (
            <span />
          )}
          <span className="side end">
            {!settings && (
              <>
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
                <button
                  type="button"
                  className="icon gear"
                  title="Settings (⌘,)"
                  onClick={() => openSettings(true)}
                >
                  <SettingsIcon size={17} />
                </button>
              </>
            )}
          </span>
        </header>
        {card && (
          <Card
            from={card.from}
            closing={card.closing}
            onClosed={cardClosed}
            presence={now}
            facts={{
              tokens: chat && chat.tokens.in + chat.tokens.out > 0 ? chat.tokens : undefined,
            }}
            state={state}
            onState={setState}
            onError={failed}
            onClose={closeCard}
            remembers={remembers}
            offRecord={{ on: offRecord, open: !chat && !reading, onChange: setOffNext }}
          />
        )}
        {settings && <SettingsPage state={state} onState={setState} onError={failed} />}
        <ImageViewer />
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
          fill={!!chat && !startedHere.current.has(chat.id)}
          offRecord={offRecord && !reading}
        />
        <div className="dock">
          {setup}
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
