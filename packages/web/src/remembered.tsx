// What she remembers about the user, on the other side of her card, in her words (§5.7): the
// memory plugin's /remembered, to read. A correction is told to her, in a conversation, where
// her memory tools make it.

import { ChevronLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import { Markdown } from "./transcript.tsx";

export function Remembered(props: {
  /** Turned to from the keyboard: focus goes to the way back. */
  keyboard: boolean;
  onBack(): void;
}) {
  const [text, setText] = useState<string>();
  const [error, setError] = useState<string>();
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (props.keyboard) back.current?.focus({ preventScroll: true });
    api.run("/remembered").then(
      (r) => setText(r.output ?? ""),
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    );
  }, [props.keyboard]);
  return (
    <section className="memory" aria-label="What I remember about you">
      <button type="button" className="flip back" ref={back} onClick={props.onBack}>
        <ChevronLeft size={14} />
        What I remember about you
      </button>
      <div className="memory-list">
        {error ? (
          <p className="hint">Couldn't load this: {error}</p>
        ) : (
          text !== undefined && <Markdown className="assistant" text={text} />
        )}
      </div>
    </section>
  );
}
