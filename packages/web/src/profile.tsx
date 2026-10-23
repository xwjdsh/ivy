// Ivy herself, at the top of the conversation: her face, her name and what she is doing.
// Clicking her shows her card, hanging from her: the same, larger, and, folded at its foot,
// what runs her (the model and the effort), out of the way of the conversation.

import { compact, type DaemonState, formatTokens, type Tokens } from "@ivy/protocol";
import { ChevronRight, Monitor, Moon, Sun } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type Appearance, api } from "./api.ts";
import ivy from "./ivy.png"; // the app's icon (app/resources/icon.png), smaller
import { Bars, Pick } from "./menu.tsx";
import type { Presence } from "./presence.ts";

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

/** What her card tells about the conversation going on. */
export interface Facts {
  /** What it has used, if anything yet. */
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
 * Her card, hanging from her at the top: who she is and what she is doing, and, folded at its
 * foot, what runs her. A click outside it or Esc puts it away.
 */
export function Card(props: {
  presence: Presence;
  facts: Facts;
  state: DaemonState | undefined;
  onState(state: DaemonState): void;
  onError(err: unknown): void;
  onClose(): void;
}) {
  const { presence, facts, state, onError, onClose } = props;
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const t = e.target as Element;
      // Her at the top toggles the card herself.
      if (!card.current?.contains(t) && !t.closest(".presence")) onClose();
    };
    addEventListener("pointerdown", away);
    return () => removeEventListener("pointerdown", away);
  }, [onClose]);
  return (
    <aside className="card" aria-label="Ivy" ref={card}>
      <div className="profile">
        <Portrait size={72} presence={presence} />
        <span className="name">Ivy</span>
        <span className={`doing ${presence.tone}`}>{presence.text}</span>
      </div>
      <Hood>
        {state && <ModelSettings state={state} onState={props.onState} onError={onError} />}
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
    </aside>
  );
}

const HOOD_KEY = "ivy.hood";

/**
 * What runs her, folded away at the foot of her card: the model, the effort, what she has to work
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
export function ModelSettings(props: {
  state: DaemonState;
  /** Also the helper model, for side work (the settings page; her card keeps to the two). */
  helper?: boolean;
  onState(state: DaemonState): void;
  onError(err: unknown): void;
}) {
  const { state, onError } = props;
  const [models, setModels] = useState<string[] | undefined>();
  useEffect(() => {
    if (state.canSwitchModel) api.models().then((m) => setModels(m.models), onError);
  }, [state.canSwitchModel, onError]);
  const choices =
    !state.model || models?.includes(state.model)
      ? (models ?? [])
      : [state.model, ...(models ?? [])];
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
          shown={state.model ? undefined : <span className="text">Choose a model</span>}
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
      {/* Apart from the pair above: the effort is the model's, the helper has its own. */}
      {props.helper && (
        <>
          <div className="row apart">
            <span className="key">Helper</span>
            <Pick
              className="model"
              below
              value={state.helperModel}
              title="A small, fast model for side work: reading a page, summing up a conversation"
              disabled={!state.model}
              search="Search models"
              options={[
                { value: "", label: "The model, at low effort" },
                ...choices.map((m) => ({ value: m, label: modelName(m), group: groups.get(m) })),
              ]}
              onChange={(m) => api.setHelperModel(m).then(props.onState, onError)}
            />
          </div>
          <p className="note">For side work: reading a page, summing up a conversation.</p>
        </>
      )}
    </div>
  );
}

/** "magpie/auto/claude-opus-5-5" → "claude-opus-5-5" */
export const modelName = (model: string) => model.slice(model.lastIndexOf("/") + 1);

/**
 * Where each model comes from, without what they all share: "magpie/auto/x" and
 * "magpie/claude/y" → "auto" and "claude".
 */
export function sources(models: string[]): Map<string, string> {
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
export const inApp = "mygo" in window;

const APPEARANCES: { value: Appearance; label: string; icon: ReactNode }[] = [
  { value: "system", label: "System", icon: <Monitor size={13} /> },
  { value: "light", label: "Light", icon: <Sun size={13} /> },
  { value: "dark", label: "Dark", icon: <Moon size={13} /> },
];

/** Light, dark or the system's, for the whole app: the title bar and menus follow too. */
export function Appearances({ onError }: { onError(err: unknown): void }) {
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
