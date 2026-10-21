// Ivy herself, at the top of the conversation: her face, her name and what she is doing.
// Clicking her opens her pane beside it, which tells more about her and, folded at its foot,
// holds what runs her (the model and the effort), out of the way of the conversation. From it,
// a page of all the conversations had with her, to find one and go to it.

import {
  type AboutSection,
  compact,
  type DaemonState,
  formatTokens,
  type SessionSummary,
  type Tokens,
} from "@ivy/protocol";
import { ChevronLeft, ChevronRight, Monitor, Moon, Search, Sun, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { type Appearance, api } from "./api.ts";
import ivy from "./ivy.png"; // the app's icon (app/resources/icon.png), smaller
import { Bars, Pick } from "./menu.tsx";
import type { Presence } from "./presence.ts";
import { byDay, timeLabel } from "./sessions.ts";

/** Her face, cut round from the app's icon. */
export function Portrait({ size, presence }: { size: number; presence?: Presence }) {
  return (
    <span
      className={`portrait${presence ? ` ${presence.tone}` : ""}`}
      style={{ width: size, height: size }}
    >
      <span className="crop">
        <img src={ivy} alt="" />
      </span>
    </span>
  );
}

/** What her pane tells about her, besides what the plugins have. */
export interface Facts {
  /** Every conversation had with her, newest first, as the daemon lists them. */
  sessions: SessionSummary[];
  /** The conversation going on, if one is. */
  current: string | undefined;
  /** What the conversation going on has used, if it has. */
  tokens: Tokens | undefined;
}

/** Ivy at the top of the conversation, as a contact sits at the top of a chat. */
export function Contact(props: { presence: Presence; open: boolean; onToggle(): void }) {
  const { presence } = props;
  return (
    <button
      type="button"
      className="presence"
      aria-expanded={props.open}
      title="About Ivy"
      onClick={props.onToggle}
    >
      <Portrait size={30} presence={presence} />
      <span className="who">
        <span className="name">Ivy</span>
        <span className={`doing ${presence.tone}`}>{presence.text}</span>
      </span>
    </button>
  );
}

/**
 * Her pane, beside the conversation: who she is and what she is keeping track of; her journal
 * behind a click; and, folded at its foot, what runs her.
 */
export function Profile(props: {
  presence: Presence;
  facts: Facts;
  state: DaemonState | undefined;
  /** Changes when what the plugins know may have: read it again. */
  refresh: unknown;
  onState(state: DaemonState): void;
  /** Go to a past conversation, open to carry on. */
  onPick(id: string): void;
  onError(err: unknown): void;
  onClose(): void;
}) {
  const { presence, facts, state, onError, refresh } = props;
  const [sections, setSections] = useState<AboutSection[]>([]);
  // Her card, or the page of conversations opened from it.
  const [page, setPage] = useState<"card" | "conversations">("card");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `refresh` is the reason to read
  useEffect(() => {
    api.about().then(setSections, onError);
  }, [refresh, onError]);
  // Esc goes back to her card before it closes the pane.
  useEffect(() => {
    if (page === "card") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        setPage("card");
      }
    };
    // Before the window's own Esc, which closes the pane.
    addEventListener("keydown", onKey, { capture: true });
    return () => removeEventListener("keydown", onKey, { capture: true });
  }, [page]);
  return (
    <aside className="pane" aria-label="Ivy">
      <div className="pane-top">
        <button type="button" className="icon" title="Close" onClick={props.onClose}>
          <X size={16} />
        </button>
      </div>
      {page === "conversations" ? (
        <Conversations
          sessions={facts.sessions.filter((s) => s.id !== facts.current)}
          onBack={() => setPage("card")}
          onPick={props.onPick}
        />
      ) : (
        <div className="pane-body">
          <div className="profile">
            <Portrait size={88} presence={presence} />
            <span className="name">Ivy</span>
            <span className={`doing ${presence.tone}`}>{presence.text}</span>
          </div>
          {sections
            .filter((s) => !s.private)
            .map((s) => (
              <section key={`${s.plugin}/${s.title}`} className="about">
                <h3>{s.title}</h3>
                <Items items={s.items} />
              </section>
            ))}
          {sections
            .filter((s) => s.private)
            .map((s) => (
              <Hidden key={`${s.plugin}/${s.title}`} section={s} />
            ))}
          <button type="button" className="go" onClick={() => setPage("conversations")}>
            <span className="key">Conversations</span>
            <span className="value">{facts.sessions.length}</span>
            <ChevronRight size={14} className="next" />
          </button>
          <Hood>
            {state && <Settings state={state} onState={props.onState} onError={onError} />}
            {inApp && <Appearances onError={onError} />}
            <dl className="facts">
              {state && (
                <div>
                  <dt>Tools</dt>
                  <dd>
                    {state.tools} from {state.plugins} plugins
                  </dd>
                </div>
              )}
              {facts.tokens && (
                <div>
                  <dt>This chat</dt>
                  <dd title={formatTokens(facts.tokens)}>
                    {compact(facts.tokens.in)} in · {compact(facts.tokens.out)} out
                  </dd>
                </div>
              )}
            </dl>
          </Hood>
        </div>
      )}
    </aside>
  );
}

/** All the past conversations, newest first, to find one by how it began or its day. */
function Conversations(props: {
  sessions: SessionSummary[];
  onBack(): void;
  onPick(id: string): void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const days = byDay(props.sessions)
    .reverse()
    .map((d) => ({
      label: d.label,
      sessions: [...d.sessions]
        .reverse()
        .filter(
          (s) =>
            !q ||
            d.label.toLowerCase().includes(q) ||
            (s.preview || "Untitled").toLowerCase().includes(q),
        ),
    }))
    .filter((d) => d.sessions.length > 0);
  return (
    <div className="pane-page">
      <div className="page-head">
        <button type="button" className="back" onClick={props.onBack}>
          <ChevronLeft size={16} />
          Ivy
        </button>
      </div>
      <label className="find">
        <Search size={14} />
        <input
          // biome-ignore lint/a11y/noAutofocus: the page is opened to search it
          autoFocus
          value={query}
          placeholder="Search conversations"
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="pane-body">
        {days.length === 0 && (
          <p className="none">{q ? "No conversation matches" : "No other conversations yet"}</p>
        )}
        {days.map((d) => (
          <section key={d.label} className="convs">
            <h3 className="when">{d.label}</h3>
            {d.sessions.map((s) => (
              <button key={s.id} type="button" className="conv" onClick={() => props.onPick(s.id)}>
                <span className="time">{timeLabel(new Date(s.updatedAt))}</span>
                <span className="preview">{s.preview || "Untitled"}</span>
                {s.busy && <span className="busy" title="Replying" />}
              </button>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

function Items({ items }: { items: AboutSection["items"] }) {
  return (
    <ul>
      {items.map((item, i) => (
        // A section is read whole each time; the index is stable within it.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <li key={i}>
          <span className="text">{item.text}</span>
          {item.detail && <span className="detail">{item.detail}</span>}
        </li>
      ))}
    </ul>
  );
}

/** A section shown only when asked for (her journal); closed again each time she's opened. */
function Hidden({ section }: { section: AboutSection }) {
  const [open, setOpen] = useState(false);
  return (
    <section className={`about hidden${open ? " open" : ""}`}>
      <button type="button" className="reveal" aria-expanded={open} onClick={() => setOpen(!open)}>
        <h3>{section.title}</h3>
        <ChevronRight size={13} className="chev" />
      </button>
      {open && <Items items={section.items} />}
    </section>
  );
}

const HOOD_KEY = "ivy.hood";

/**
 * What runs her, folded away at the foot of her pane: the model, the effort, what she has to work
 * with. Whether it is open is remembered here, in this browser.
 */
function Hood({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(HOOD_KEY) === "open";
    } catch {
      return false;
    }
  });
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(HOOD_KEY, open ? "closed" : "open");
    } catch {}
  };
  return (
    <div className={`hood${open ? " open" : ""}`}>
      <button type="button" className="hood-toggle" aria-expanded={open} onClick={toggle}>
        Under the hood
        <ChevronRight size={13} className="turn" />
      </button>
      {open && <div className="hood-body">{children}</div>}
    </div>
  );
}

/** What each effort is for, in a word. */
const EFFORTS: Record<string, string> = {
  low: "Fastest",
  medium: "Balanced",
  high: "Thorough",
  xhigh: "Deeper",
  max: "Deepest",
};

/** The model and the effort, both the daemon's: a change applies to every session. */
function Settings(props: {
  state: DaemonState;
  onState(state: DaemonState): void;
  onError(err: unknown): void;
}) {
  const { state, onError } = props;
  const [models, setModels] = useState<string[] | undefined>();
  useEffect(() => {
    if (state.canSwitchModel) api.models().then((m) => setModels(m.models), onError);
  }, [state.canSwitchModel, onError]);
  const choices = models?.includes(state.model) ? models : [state.model, ...(models ?? [])];
  const groups = sources(choices);
  const efforts = state.efforts;
  return (
    <div className="settings">
      <div className="row">
        <span className="key">Model</span>
        <Pick
          className="model"
          below
          value={state.model}
          title="The model, for every session"
          disabled={!state.canSwitchModel}
          search="Search models"
          options={choices.map((m) => ({ value: m, label: modelName(m), group: groups.get(m) }))}
          onChange={(m) => api.setModel(m).then(props.onState, onError)}
        />
      </div>
      <div className="row">
        <span className="key">Effort</span>
        <Pick
          className={`effort${state.effortUsed ? "" : " unused"}`}
          below
          value={state.effort}
          title={
            state.effortUsed
              ? `Effort (this model gets ${state.effortUsed})`
              : "Effort (not sent to this model)"
          }
          options={efforts.map((e, i) => ({
            value: e,
            label: e === "xhigh" ? "Extra high" : capitalize(e),
            detail: EFFORTS[e],
            icon: <Bars level={i + 1} of={efforts.length} />,
          }))}
          onChange={(e) => api.setEffort(e).then(props.onState, onError)}
        />
      </div>
    </div>
  );
}

/** "magpie/auto/claude-opus-5-5" → "claude-opus-5-5" */
const modelName = (model: string) => model.slice(model.lastIndexOf("/") + 1);

/**
 * Where each model comes from, without what they all share: "magpie/auto/x" and
 * "magpie/claude/y" → "auto" and "claude".
 */
function sources(models: string[]): Map<string, string> {
  const paths = models.map((m) => m.split("/").slice(0, -1));
  let shared = 0;
  while (
    paths.length > 0 &&
    paths.every((p) => p.length > shared + 1 && p[shared] === paths[0]?.[shared])
  ) {
    shared++;
  }
  return new Map(models.map((m, i) => [m, paths[i]?.slice(shared).join("/") ?? ""]));
}

/**
 * Only the app has an appearance to set; in a browser the page follows the system's. MyGo
 * sets up `window.mygo` before the page's scripts run.
 */
const inApp = "mygo" in window;

const APPEARANCES: { value: Appearance; label: string; icon: ReactNode }[] = [
  { value: "system", label: "System", icon: <Monitor size={13} /> },
  { value: "light", label: "Light", icon: <Sun size={13} /> },
  { value: "dark", label: "Dark", icon: <Moon size={13} /> },
];

/** Light, dark or the system's, for the whole app: the title bar and menus follow too. */
function Appearances({ onError }: { onError(err: unknown): void }) {
  const [value, setValue] = useState<Appearance | undefined>();
  useEffect(() => {
    api.appearance().then(setValue, onError);
  }, [onError]);
  const pick = (next: Appearance) => {
    setValue(next);
    api.setAppearance(next).then(setValue, onError);
  };
  return (
    <div className="settings">
      <div className="row">
        <span className="key">Appearance</span>
        <div className="segments">
          {APPEARANCES.map((a) => (
            <button
              key={a.value}
              type="button"
              aria-pressed={value === a.value}
              aria-label={a.label}
              title={a.label}
              onClick={() => pick(a.value)}
            >
              {a.icon}
              {/* Only the chosen one is named, so the three fit beside the label. */}
              {value === a.value && <span>{a.label}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
