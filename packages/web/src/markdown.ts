// Replies as HTML. What the model writes is not trusted: raw HTML in it is shown as text,
// links go only to the web or mail, and an image loads only when the user clicks to show
// it, so a reply can't run script in the window (which can answer permission prompts) or,
// unseen, send what it read to a server by naming it in an image's URL. index.html's
// Content-Security-Policy enforces the same.

import { Marked, type Tokens } from "marked";
import { highlight } from "./highlight.ts";

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Only links a browser opens for the user: no javascript:, data: or this app's own pages. */
const safeHref = (href: string) => (/^(https?:|mailto:)/i.test(href) ? href : undefined);

/** Images the user chose to show, until the window reloads: shown again as a reply re-renders. */
const shown = new Set<string>();

/** Show an image a reply names, and every later render of it. */
export function showImage(src: string): void {
  shown.add(src);
}

/** Lucide's "copy" icon, for the button on code blocks. */
const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';

/** Lucide's "image" icon, for an image not shown yet. */
const IMAGE_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>';

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html: ({ text }: Tokens.HTML | Tokens.Tag) => escapeHtml(text),
    code({ text, lang }: Tokens.Code) {
      const name = lang?.trim().split(/\s/)[0] ?? "";
      const body = highlight(text, name) ?? `<pre><code>${escapeHtml(text)}</code></pre>`;
      return (
        `<div class="code"><div class="code-head"><span>${escapeHtml(name || "text")}</span>` +
        `<button type="button" class="copy" title="Copy">${COPY_ICON}</button></div>${body}</div>`
      );
    },
    link({ href, title, tokens }: Tokens.Link) {
      const text = this.parser.parseInline(tokens);
      const safe = safeHref(href);
      if (!safe) return text;
      const t = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(safe)}"${t} target="_blank" rel="noreferrer">${text}</a>`;
    },
    image({ href, text }: Tokens.Image) {
      const label = escapeHtml(text || "Image");
      if (!/^https:/i.test(href)) return label;
      const src = escapeHtml(href);
      if (shown.has(href)) return `<img class="reply-image" src="${src}" alt="${label}">`;
      // Where it comes from is said, and the whole address is on hover.
      const host = escapeHtml(new URL(href).host);
      return (
        `<button type="button" class="show-image" data-src="${src}" title="${src}">` +
        `${IMAGE_ICON}<span>${label}</span><span class="from">${host}</span></button>`
      );
    },
  },
});

export function renderMarkdown(markdown: string): string {
  return marked.parse(markdown, { async: false });
}
