// Below the conversation: a permission the running turn waits for, the messages queued
// behind it, and the box the user writes in.

import type { PermissionAnswer, PermissionAsk, Prompt } from "@ivy/protocol";
import { ArrowUp, CornerDownRight, Square, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Portrait } from "./profile.tsx";

const ANSWERS: Record<PermissionAnswer, string> = {
  once: "Allow once",
  session: "Allow for this session",
  always: "Always allow",
  deny: "Deny",
};

export function Permission(props: {
  ask: PermissionAsk;
  onAnswer(choice: PermissionAnswer): void;
}) {
  const { ask } = props;
  // Deny on the left, the allows on the right with the usual one (once) rightmost, where
  // dialogs put their default.
  const allows = ask.choices.filter((c) => c !== "deny").reverse();
  return (
    <div className="permission fresh" role="alertdialog" aria-label="Permission">
      <div className="ask">
        <Portrait size={28} />
        <div>
          <div className="question">
            Can I use <strong>{ask.label.plugin}</strong> to {ask.label.text}?
          </div>
          <div className="meta">
            <span className={`risk ${ask.risk}`}>{ask.risk}</span>
            <span>{ask.reason}</span>
            <span className="mono">{ask.name}</span>
          </div>
        </div>
      </div>
      <details>
        <summary>Show input</summary>
        <pre>{JSON.stringify(ask.input, null, 2)}</pre>
      </details>
      <div className="choices">
        {ask.choices.includes("deny") && (
          <button type="button" className="ghost" onClick={() => props.onAnswer("deny")}>
            {ANSWERS.deny}
          </button>
        )}
        <span className="grow" />
        {allows.map((c) => (
          <button
            type="button"
            key={c}
            className={c === "once" ? "primary" : "secondary"}
            onClick={() => props.onAnswer(c)}
          >
            {ANSWERS[c]}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Queue(props: { queue: Prompt[]; onWithdraw(p: Prompt): void }) {
  return (
    <div className="queue">
      {props.queue.map((p) => (
        <div key={p.id} className="waiting fresh">
          <CornerDownRight size={14} />
          <span className="text">{p.text}</span>
          <span className="tag">Queued</span>
          <button
            type="button"
            className="icon"
            title="Don't send"
            onClick={() => props.onWithdraw(p)}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function Composer(props: {
  busy: boolean;
  /** Writing to a past conversation, to carry it on. */
  replying: boolean;
  onSend(text: string): Promise<void>;
  onStop(): void;
}) {
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => input.current?.focus(), []);
  // Grow with the text, up to the CSS max-height, and again when the width changes the
  // wrapping (or the stylesheet arrives after the first render).
  // biome-ignore lint/correctness/useExhaustiveDependencies: fits again whenever the text changes
  useLayoutEffect(() => fit(input.current), [text]);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth !== width) {
        width = el.clientWidth;
        fit(el);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const submit = () => {
    const message = text.trim();
    if (!message) return;
    setText("");
    props.onSend(message).catch(() => setText((t) => t || message));
  };
  const stop = props.busy && !text.trim();
  return (
    // Clicking anywhere in the box writes in it.
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: the textarea takes the keys
    <div
      className="composer"
      onClick={(e) => {
        if (!(e.target as Element).closest("button")) input.current?.focus();
      }}
    >
      <textarea
        ref={input}
        rows={1}
        value={text}
        placeholder={
          props.busy
            ? "Ivy is replying; a message now is sent next"
            : props.replying
              ? "Reply in this conversation"
              : "Talk to Ivy"
        }
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends; Shift+Enter is a new line; Enter that picks an IME candidate is the IME's.
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape" && props.busy) {
            e.preventDefault(); // stopping takes this Esc
            props.onStop();
          }
        }}
      />
      {stop ? (
        <button type="button" className="send stop" title="Stop (Esc)" onClick={props.onStop}>
          <Square size={12} fill="currentColor" />
        </button>
      ) : (
        <button
          type="button"
          className="send"
          title="Send (Enter)"
          disabled={!text.trim()}
          onClick={submit}
        >
          <ArrowUp size={18} strokeWidth={2.5} />
        </button>
      )}
    </div>
  );
}

function fit(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}
