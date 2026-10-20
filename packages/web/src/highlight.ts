// Code blocks in color. Shiki and each language load the first time a reply needs them, so
// the window opens without them; until then a block shows plain, and once one arrives the
// replies render again (`useHighlight`). Shiki escapes the code it colors.

import { useSyncExternalStore } from "react";
import type { HighlighterCore } from "shiki/core";
import { bundledLanguages } from "shiki/langs";

type Lang = keyof typeof bundledLanguages;

let highlighter: HighlighterCore | undefined;
let starting: Promise<HighlighterCore> | undefined;
/** Languages asked for, and those ready (by the name a reply gives, aliases too). */
const loading = new Set<string>();
const ready = new Set<string>();
/** Bumped when shiki or a language arrives, which changes how replies render. */
let version = 0;
const listeners = new Set<() => void>();

function changed() {
  version++;
  for (const listener of listeners) listener();
}

function start(): Promise<HighlighterCore> {
  starting ??= Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("shiki/themes/github-light.mjs"),
    import("shiki/themes/github-dark.mjs"),
  ]).then(async ([core, engine, light, dark]) => {
    highlighter = await core.createHighlighterCore({
      themes: [light.default, dark.default],
      engine: engine.createJavaScriptRegexEngine(),
    });
    return highlighter;
  });
  return starting;
}

function load(lang: Lang) {
  if (loading.has(lang)) return;
  loading.add(lang);
  start()
    .then((h) => h.loadLanguage(bundledLanguages[lang]))
    .then(
      () => {
        ready.add(lang);
        changed();
      },
      (err) => console.warn(`highlight ${lang}:`, err),
    );
}

/** The code as colored HTML, or undefined while its language isn't loaded (or isn't known). */
export function highlight(code: string, lang: string): string | undefined {
  const name = lang.toLowerCase();
  if (!(name in bundledLanguages)) return undefined;
  if (!highlighter || !ready.has(name)) {
    load(name as Lang);
    return undefined;
  }
  return highlighter.codeToHtml(code, {
    lang: name,
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: "light",
  });
}

/** Render again when highlighting becomes available. */
export function useHighlight(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
}
