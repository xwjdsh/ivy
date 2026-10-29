// The chat window: one long conversation with Ivy, the past ones above the one going on now,
// her at the top, and her card growing out of her face when she is clicked. Like the TUI it is a client of
// the daemon, which runs the sessions; this page only shows them and sends what the user types.
// The session going on is in the URL's hash, so a reload keeps it. What is written always goes
// on at the end: after a pause it starts the next stretch, a session of its own (sessions.ts).

import type { DaemonState, SessionEvent, SessionSummary } from "@ivy/protocol";
import {
  ChevronLeft,
  CircleAlert,
  LoaderCircle,
  Search as SearchIcon,
  Settings as SettingsIcon,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, follow } from "./api.ts";
import { apply, type Chat, chatOf, emptyChat } from "./chat.ts";
import { Composer, Permission, Queue } from "./composer.tsx";
import { forgetStretch, History, keepStretch } from "./history.tsx";
import { presence } from "./presence.ts";
import { Card, Contact } from "./profile.tsx";
import { type Found, Search } from "./search.tsx";
import { carriesOn, isHers, when } from "./sessions.ts";
import { SettingsPage } from "./settings.tsx";
import { Timeline } from "./transcript.tsx";
import { ImageViewer } from "./viewer.tsx";

const sessionInHash = () => decodeURIComponent(location.hash.slice(1)) || undefined;

/** Session events that change the list: a session started, ran, or finished a turn. */
const LISTED = new Set<SessionEvent["type"]>(["started", "prompt", "turn_start", "turn_end"]);

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
  /** Set, a new object each time, to bring a message found into view. */
  const [jump, setJump] = useState<Found | undefined>();
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
      if (LISTED.has(e.type)) reloadList();
      // She wrote first (only when the user hasn't written for a while): her conversation is
      // the one going on now, if that takes nothing from the user (a new chat, or the window
      // away); else it is in the list, and her notification takes them there.
      const away = document.hidden || !document.hasFocus();
      if (e.type === "started" && (!chatId.current || away)) {
        setOffNext(false); // as open(id) does: a switch set for a new chat isn't for hers
        location.hash = encodeURIComponent(e.sessionId);
      }
    };
    // Opening the window carries on the conversation the talk was in; after a pause, what is
    // written starts the next, and that one is above it.
    let first = true;
    const onConnect = (up: boolean) => {
      setConnected(up);
      if (!up) return;
      const carryOn = first && !chatId.current && !sessionInHash();
      first = false;
      api.sessions().then((list) => {
        setSessions(list);
        const last = list[0];
        if (carryOn && !chatId.current && last && carriesOn(last)) {
          location.hash = encodeURIComponent(last.id);
        }
      }, failed);
      api.state().then(setState, failed);
      void show(chatId.current ?? sessionInHash());
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
  }, [show, reloadList, failed]);

  const open = useCallback(
    (id: string | undefined) => {
      // A new one started from one off the record stays so (kept by mistake can't be undone;
      // the switch turns it off); any other starts on the record. Nothing is saved.
      if (id) setOffNext(false);
      else setOffNext((on) => on || offNow.current);
      setJump(undefined);
      location.hash = id ? encodeURIComponent(id) : "";
      if (!id) void show(undefined); // an empty hash may not fire hashchange
    },
    [show],
  );

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
        // Her card closes first, then the settings.
        if (card && !card.closing) closeCard();
        else if (settings) setSettings(false);
      }
      // ⌘,: the settings, as in every Mac app.
      else if (plain && e.key === ",") {
        e.preventDefault();
        openSettings(!settings);
      }
      // ⌘N: a fresh start, as on her card.
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
  }, [card, closeCard, settings, openSettings, open]);

  /** Go to a message found, where it is in the talk. */
  const pick = (found: Found) => {
    setSettings(false); // to be seen
    setJump(found);
  };

  /** A conversation being started: a message sent meanwhile goes to it too, not to another. */
  const starting = useRef<Promise<string> | undefined>(undefined);

  const send = async (text: string, images: string[]) => {
    setError(undefined);
    // What is written goes on at the end, where the view goes with it.
    setToEnd((n) => (n ?? 0) + 1);
    setJump(undefined); // gone to; not again when the view changes
    try {
      const pending = starting.current;
      let id = pending ? await pending : chat?.id;
      let off = offNext;
      const summary = chat && sessions.find((s) => s.id === chat.id);
      const hers = sessions[0];
      if (pending) {
        // Goes where the message before it went.
      } else if (chat && summary && hers && hers !== summary && isHers(hers) && carriesOn(hers)) {
        // She wrote while this was on screen: her message is newer than it (it is listed, and
        // hers first), and what is written now answers it, where she wrote it.
        keepStretch(chat);
        history.replaceState(null, "", `#${encodeURIComponent(hers.id)}`);
        await show(hers.id);
        id = hers.id;
      } else if (chat && summary && !chat.running && !carriesOn(summary, chat.context)) {
        // After a pause, a new day, or once it has grown too large, this starts the next
        // stretch; one off the record stays so, as a fresh start from it does (see open).
        keepStretch(chat);
        off ||= chat.offRecord === true;
        id = undefined;
      }
      if (!id) {
        starting.current = api.createSession(off);
        try {
          id = await starting.current;
        } finally {
          starting.current = undefined;
        }
        startedHere.current.add(id);
        chatId.current = id;
        setChat(emptyChat(id, off));
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
      forgetStretch(id);
      if (chatId.current === id) open(undefined);
    } catch (err) {
      failed(err);
    }
    reloadList();
  };

  // Off the record is decided as a conversation starts, for all of it
  // (docs/design/companion.md#off-the-record-and-taken-back).
  const offRecord = chat ? chat.offRecord === true : offNext;
  const composer = (
    <Composer
      busy={chat?.running !== undefined}
      noModel={state?.model === ""}
      offRecord={offRecord}
      onSend={send}
      onStop={() => chat && api.interrupt(chat.id).catch(failed)}
    />
  );
  const past = sessions.filter((s) => s.id !== chat?.id);
  // Set apart from the past above by when it began; one just started here, now.
  const current = chat && sessions.find((s) => s.id === chat.id);
  const began = chat && past[0] ? when(current?.createdAt, past[0].createdAt) : undefined;
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
            offRecord={{ on: offRecord, open: !chat, onChange: setOffNext }}
            onFresh={chat ? () => open(undefined) : undefined}
          />
        )}
        {settings && <SettingsPage state={state} onState={setState} onError={failed} />}
        <ImageViewer />
        {searching && <Search onPick={pick} onClose={closeSearch} />}
        <Timeline
          key={chat?.id ?? ""}
          chat={chat}
          toEnd={toEnd}
          jump={chat && jump?.id === chat.id ? jump : undefined}
          history={(place) => (
            <History sessions={past} place={place} jump={jump} onDelete={remove} />
          )}
          fill={!!chat && !startedHere.current.has(chat.id)}
          offRecord={offRecord}
          began={began}
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
