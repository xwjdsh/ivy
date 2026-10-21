// An image shown whole, over the window: one the user sent, or one a reply showed. A click
// anywhere or Esc puts it away.

import { useEffect, useState } from "react";

const EVENT = "ivy:view-image";

/** Show an image over the window. */
export function viewImage(src: string): void {
  dispatchEvent(new CustomEvent(EVENT, { detail: src }));
}

/** Where images are shown: once, in the window. */
export function ImageViewer() {
  const [src, setSrc] = useState<string | undefined>();
  useEffect(() => {
    const view = (e: Event) => setSrc((e as CustomEvent<string>).detail);
    addEventListener(EVENT, view);
    return () => removeEventListener(EVENT, view);
  }, []);
  useEffect(() => {
    if (!src) return;
    // First, so the composer's Esc (stopping a reply) doesn't take it.
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setSrc(undefined);
    };
    addEventListener("keydown", esc, true);
    return () => removeEventListener("keydown", esc, true);
  }, [src]);
  if (!src) return null;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: Esc closes it too, above
    <div className="viewer" onClick={() => setSrc(undefined)}>
      <img className="whole" src={src} alt="" />
    </div>
  );
}
