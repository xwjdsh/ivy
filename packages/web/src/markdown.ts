// Replies as HTML. What the model writes is not trusted: raw HTML in it is shown as text,
// links go only to the web or mail, and images are links rather than loaded, so a reply
// can't run script in the window (which can answer permission prompts) or send what it
// read to a server by naming it in an image's URL. index.html's Content-Security-Policy
// enforces the same.

import { Marked, type Tokens } from "marked";
import { highlight } from "./highlight.ts";

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Only links a browser opens for the user: no javascript:, data: or this app's own pages. */
const safeHref = (href: string) => (/^(https?:|mailto:)/i.test(href) ? href : undefined);

/** Lucide's "copy" icon, for the button on code blocks. */
const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';

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
      const safe = safeHref(href);
      const label = escapeHtml(text || href);
      return safe
        ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noreferrer">🖼 ${label}</a>`
        : label;
    },
  },
});

export function renderMarkdown(markdown: string): string {
  return marked.parse(markdown, { async: false });
}
