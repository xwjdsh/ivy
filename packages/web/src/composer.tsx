// Below the conversation: a permission the running turn waits for, the messages queued
// behind it, and the box the user writes in, with the images going along.

import type { PermissionAnswer, PermissionAsk, Prompt } from "@ivy/protocol";
import { ArrowUp, CornerDownRight, ImagePlus, LoaderCircle, Square, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import { sendable } from "./images.ts";
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
        <div key={p.id} className="queued fresh">
          <CornerDownRight size={14} />
          <span className="text">{p.text || imagesNote(p.images)}</span>
          {p.text && p.images && <span className="tag">{imagesNote(p.images)}</span>}
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

const imagesNote = (images: string[] = []) =>
  images.length === 1 ? "An image" : `${images.length} images`;

/** An image going with the message: uploaded as it is attached (DESIGN.md §5.4). */
interface Attached {
  key: string;
  /** The image as the page has it, to show. */
  preview: string;
  /** Its name once the daemon has it. */
  name?: string;
  /** Why it can't go. */
  problem?: string;
}

export function Composer(props: {
  busy: boolean;
  /** Writing to a past conversation, to carry it on. */
  replying: boolean;
  /** No model chosen yet (a new install): nothing can be sent until one is. */
  noModel: boolean;
  /** Writing off the record: shown where the user writes, as a reminder. */
  offRecord: boolean;
  onSend(text: string, images: string[]): Promise<void>;
  onStop(): void;
}) {
  const [text, setText] = useState("");
  const [attached, setAttached] = useState<Attached[]>([]);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const attach = useCallback((files: Iterable<File>) => {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const key = crypto.randomUUID();
      const set = (change: Partial<Attached>) =>
        setAttached((all) => all.map((a) => (a.key === key ? { ...a, ...change } : a)));
      setAttached((all) => [...all, { key, preview: URL.createObjectURL(file) }]);
      sendable(file)
        .then(api.upload)
        .then(
          (name) => set({ name }),
          (err) => set({ problem: err instanceof Error ? err.message : String(err) }),
        );
    }
  }, []);
  const detach = (key: string) =>
    setAttached((all) =>
      all.filter((a) => {
        if (a.key === key) URL.revokeObjectURL(a.preview);
        return a.key !== key;
      }),
    );
  // An image dropped anywhere on the window goes with the message, rather than the window
  // opening it in place of the page.
  useEffect(() => {
    const files = (e: DragEvent) => e.dataTransfer?.types.includes("Files");
    const over = (e: DragEvent) => {
      if (files(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      attach(e.dataTransfer?.files ?? []);
      input.current?.focus();
    };
    addEventListener("dragover", over);
    addEventListener("drop", drop);
    return () => {
      removeEventListener("dragover", over);
      removeEventListener("drop", drop);
    };
  }, [attach]);
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
  const uploading = attached.some((a) => !a.name && !a.problem);
  // One that can't go holds the message until it is removed: it never goes without it unseen.
  const problem = attached.find((a) => a.problem)?.problem;
  const images = attached.flatMap((a) => (a.name ? [a.name] : []));
  const ready =
    !props.noModel && !uploading && !problem && (text.trim() !== "" || images.length > 0);
  const submit = () => {
    if (!ready) return;
    const message = text.trim();
    const sent = attached;
    setText("");
    setAttached([]);
    props.onSend(message, images).then(
      () => {
        for (const a of sent) URL.revokeObjectURL(a.preview);
      },
      () => {
        setText((t) => t || message);
        setAttached((now) => (now.length ? now : sent));
      },
    );
  };
  const stop = props.busy && !text.trim() && attached.length === 0;
  return (
    // Clicking anywhere in the box writes in it.
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: the textarea takes the keys
    <div
      className={`composer${props.offRecord ? " off-record" : ""}`}
      onClick={(e) => {
        if (!(e.target as Element).closest("button")) input.current?.focus();
      }}
    >
      {attached.length > 0 && (
        <div className="attached">
          {attached.map((a) => (
            <div key={a.key} className={`thumb${a.problem ? " problem" : ""}`} title={a.problem}>
              <img src={a.preview} alt="" />
              {!a.name && !a.problem && (
                <span className="uploading">
                  <LoaderCircle size={16} className="spin" />
                </span>
              )}
              <button type="button" className="detach" title="Remove" onClick={() => detach(a.key)}>
                <X size={11} strokeWidth={3} />
              </button>
            </div>
          ))}
          {problem && <p className="attach-problem">{problem}. Remove it to send.</p>}
        </div>
      )}
      <textarea
        ref={input}
        rows={1}
        value={text}
        placeholder={
          props.noModel
            ? "Choose a model in Settings to start"
            : props.busy
              ? "Ivy is replying; a message now is sent next"
              : props.replying
                ? "Reply in this conversation"
                : props.offRecord
                  ? "Off the record · nothing is kept"
                  : "Talk to Ivy"
        }
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
          if (files.length === 0) return; // text pastes as text
          e.preventDefault();
          attach(files);
        }}
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
      <input
        ref={picker}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          attach(e.target.files ?? []);
          e.target.value = ""; // the same image can be picked again
        }}
      />
      <button
        type="button"
        className="attach"
        title="Add images"
        onClick={() => picker.current?.click()}
      >
        <ImagePlus size={18} />
      </button>
      {/* Two buttons, not one changing: the web view kept the stop button's look on the send
          button it became, drawing it enabled while it was disabled. */}
      {stop ? (
        <button
          key="stop"
          type="button"
          className="send stop"
          title="Stop (Esc)"
          onClick={props.onStop}
        >
          <Square size={12} fill="currentColor" />
        </button>
      ) : (
        <button
          key="send"
          type="button"
          className="send"
          title="Send (Enter)"
          disabled={!ready}
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
