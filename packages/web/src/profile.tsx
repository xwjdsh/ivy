// Ivy herself, at the top of the conversation: her face, her name and what she is doing.
// Clicking her grows her card out of her face: the same, larger, and, folded at its foot,
// what runs her (the model and the effort), out of the way of the conversation.

import { compact, type DaemonState, formatTokens, type Tokens } from "@ivy/protocol";
import { ChevronRight, Monitor, Moon, Sun } from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { type Appearance, api } from "./api.ts";
import ivy from "./ivy.png"; // the app's icon (app/resources/icon.png), smaller
import { Bars, Pick } from "./menu.tsx";
import type { Presence } from "./presence.ts";
import { Remembered } from "./remembered.tsx";

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
export function Contact(props: {
  presence: Presence;
  open: boolean;
  onToggle(e: { currentTarget: HTMLElement }): void;
}) {
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
 * Her card: who she is and what she is doing, and, folded at its foot, what runs her. It grows
 * out of the face that was clicked, as a phone's island does, and goes back into it: one face on
 * screen at a time. A click outside it or Esc puts it away.
 */
export function Card(props: {
  /** The face it grows from, hidden while the card is out. */
  from: HTMLElement;
  /** On its way back into the face; `onClosed` once there. */
  closing: boolean;
  onClosed(): void;
  presence: Presence;
  facts: Facts;
  state: DaemonState | undefined;
  onState(state: DaemonState): void;
  onError(err: unknown): void;
  onClose(): void;
  /** Whether there is what she remembers about the user to turn to (the memory plugin on). */
  remembers: boolean;
  /** Off the record: set for a conversation about to start (`open`), then fixed for all of it. */
  offRecord: { on: boolean; open: boolean; onChange(on: boolean): void };
}) {
  const { from, presence, facts, state, onError, onClose } = props;
  const card = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const row = useRef<HTMLButtonElement>(null);
  // Her side, or turned to what she remembers about the user (with how it was turned to).
  const [side, setSide] = useState<{ keyboard: boolean }>();
  useMorph(card, from, props.closing, props.onClosed);
  const turnBack = useCallback((keyboard: boolean) => {
    setSide(undefined);
    if (keyboard) requestAnimationFrame(() => row.current?.focus({ preventScroll: true }));
  }, []);
  // Esc turns her card back first, caught before the window's Esc (app.tsx) puts it away.
  useEffect(() => {
    if (!side) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      turnBack(side.keyboard);
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [side, turnBack]);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      // The face it came from toggles the card itself.
      if (!card.current?.contains(t) && !from.contains(t)) onClose();
    };
    addEventListener("pointerdown", away);
    return () => removeEventListener("pointerdown", away);
  }, [from, onClose]);
  // Opened from the keyboard, focus goes to her in the card, and back to the face she came
  // from once she is put away. Opened with a click, it stays put: WebKit would ring a button
  // focused from code, as if by keyboard.
  useEffect(() => {
    if (!from.matches(":focus-visible")) return;
    toggle.current?.focus({ preventScroll: true });
    const here = card.current;
    return () => {
      // Not if the user went on elsewhere (a click on the composer put it away).
      const now = document.activeElement;
      if (!now || now === document.body || here?.contains(now)) from.focus({ preventScroll: true });
    };
  }, [from]);
  return (
    <aside className={`card${side ? " wide" : ""}`} aria-label="Ivy" ref={card}>
      <button
        type="button"
        className="profile"
        ref={toggle}
        aria-label="Put Ivy's card away"
        title="Put away"
        onClick={onClose}
      >
        <Portrait size={72} presence={presence} />
        <span className="name">Ivy</span>
        <span className={`doing ${presence.tone}`}>{presence.text}</span>
      </button>
      {side ? (
        <Remembered keyboard={side.keyboard} onBack={() => turnBack(side.keyboard)} />
      ) : (
        <>
          {props.remembers && (
            <button
              type="button"
              className="flip remembered"
              ref={row}
              // A click has a count; Enter or Space on a focused button, none.
              onClick={(e) => setSide({ keyboard: e.detail === 0 })}
            >
              What I remember about you
              <ChevronRight size={14} />
            </button>
          )}
          <label className={`off-record${props.offRecord.open ? "" : " fixed"}`}>
            <span className="what">Off the record</span>
            <input
              type="checkbox"
              className="st-switch"
              checked={props.offRecord.on}
              disabled={!props.offRecord.open}
              onChange={(e) => props.offRecord.onChange(e.target.checked)}
            />
            <span className="note">
              {props.offRecord.open
                ? "Not kept, and deleted when it ends."
                : props.offRecord.on
                  ? "On until this conversation ends."
                  : "Only for a new conversation."}
            </span>
          </label>
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
        </>
      )}
    </aside>
  );
}

const MORPH = { duration: 240, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "both" } as const;

/**
 * The card growing out of the face that was clicked, and going back into it: its surface
 * unclipped from the face's shape, her portrait (and, from the top, her name and what she is
 * doing) moved and scaled from where they were; the rest fading in. Measured once each way,
 * never while it runs; with less motion asked for, it just appears and goes.
 */
function useMorph(
  card: RefObject<HTMLElement | null>,
  from: HTMLElement,
  closing: boolean,
  onClosed: () => void,
) {
  const running = useRef<Animation[]>([]);
  const back = useRef(false);
  const gone = useRef(false);
  const still = useRef(matchMedia("(prefers-reduced-motion: reduce)").matches);
  // The latest, so a parent's new function each render doesn't run the closing again.
  const closed = useRef(onClosed);
  closed.current = onClosed;

  // Out of the face, which hides meanwhile.
  useLayoutEffect(() => {
    const el = card.current;
    if (!el) return;
    // Safe to run again on the same card (from changing; React's checks in development).
    gone.current = false;
    back.current = false;
    from.style.visibility = "hidden";
    // The card takes her place at the top: it is her, grown.
    const parent = el.offsetParent?.getBoundingClientRect();
    el.style.top = `${from.getBoundingClientRect().top - (parent?.top ?? 0) - 6}px`;
    if (!still.current) running.current = grow(el, from);
    // Done, the card is as it is: no clip left to cut off its menus.
    const all = running.current;
    void Promise.all(all.map((a) => a.finished)).then(
      () => {
        if (running.current === all && !back.current) for (const a of all) a.cancel();
      },
      () => {},
    );
    return () => {
      // Put away by another way (a search, the settings): nothing left to finish.
      gone.current = true;
      for (const a of running.current) a.cancel();
      from.style.visibility = "";
    };
  }, [card, from]);

  // Back into it: the same, reversed; turned back midway if it was still growing.
  useEffect(() => {
    const el = card.current;
    // Once per closing, however often the card renders meanwhile.
    if (!closing || !el || back.current) return;
    back.current = true;
    const done = () => {
      if (!gone.current) closed.current();
    };
    if (still.current) return done();
    const going = running.current.some((a) => a.playState === "running")
      ? running.current
      : grow(el, from);
    running.current = going;
    for (const a of going) a.reverse();
    void Promise.all(going.map((a) => a.finished)).then(done, () => {});
  }, [closing, card, from]);
}

/** The animations of the card growing from `from` (see useMorph). */
function grow(card: HTMLElement, from: HTMLElement): Animation[] {
  const c = card.getBoundingClientRect();
  const f = from.getBoundingClientRect();
  const out: Animation[] = [
    card.animate(
      [
        {
          clipPath: `inset(${f.top - c.top}px ${c.right - f.right}px ${c.bottom - f.bottom}px ${f.left - c.left}px round 999px)`,
        },
        // Past the card's edge and shadow, which grow out of it rather than appear at the end.
        { clipPath: "inset(-48px round 66px)" },
      ],
      MORPH,
    ),
  ];
  // What the card shares with the face moves from where it was.
  const move = (selector: string) => {
    const to = card.querySelector<HTMLElement>(`.profile ${selector}`);
    const was = from.querySelector<HTMLElement>(selector);
    if (!to || !was) return;
    const a = to.getBoundingClientRect();
    const b = was.getBoundingClientRect();
    const dx = b.left + b.width / 2 - (a.left + a.width / 2);
    const dy = b.top + b.height / 2 - (a.top + a.height / 2);
    out.push(
      to.animate(
        [
          // Its width: the same text or the same round face, so the ratio is the size's.
          { transform: `translate(${dx}px, ${dy}px) scale(${b.width / a.width})` },
          { transform: "none" },
        ],
        MORPH,
      ),
    );
  };
  move(".portrait");
  // The large face's halo comes as it lands; the small one has none.
  const face = card.querySelector<HTMLElement>(".profile .portrait");
  if (face) {
    const halo = getComputedStyle(face).boxShadow;
    out.push(
      face.animate(
        [
          { boxShadow: "0 0 0 0 transparent" },
          { boxShadow: "0 0 0 0 transparent", offset: 0.4 },
          { boxShadow: halo },
        ],
        MORPH,
      ),
    );
  }
  move(".name");
  move(".doing");
  const rest = card.querySelector<HTMLElement>(".hood");
  if (rest) {
    out.push(rest.animate([{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1 }], MORPH));
  }
  return out;
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
