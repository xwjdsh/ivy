import { expect, test } from "bun:test";
import type { ToolResult } from "@ivy/plugin-api";
import { createWebPlugin } from "./index.ts";
import { fetchPage, htmlText, isPrivate, type Page, PageError } from "./page.ts";

const log = { debug() {}, info() {}, warn() {}, error() {} };

async function plugin(read: (url: string) => Promise<Page>) {
  const asked: Array<{ system: string; prompt: string }> = [];
  const p = createWebPlugin(read);
  await p.setup?.({
    config: {},
    dataDir: "",
    soulFile: "",
    log,
    history: { sessions: () => [], messages: () => [] },
    helper: {
      async complete(call) {
        asked.push(call);
        return "It airs on Friday.";
      },
    },
  });
  const tool = p.tools?.find((t) => t.name === "fetch");
  if (!tool) throw new Error("no fetch tool");
  const run = (input: object, sessionId = "s", turn = 1): Promise<ToolResult> =>
    Promise.resolve(
      tool.run(input as never, {
        signal: new AbortController().signal,
        log,
        sessionId,
        turn,
        tainted: false,
      }),
    );
  return { p, tool, run, asked };
}

const page: Page = {
  url: "https://a.example/finale",
  title: "Finale",
  text: "The finale airs Friday.",
};

test("a page is read by the helper, which hands back an answer marked as outside content", async () => {
  const { run, asked } = await plugin(async () => page);
  const r = await run({ url: page.url, question: "when does it air?" });
  expect(r).toEqual({
    content: "From https://a.example/finale (Finale):\nIt airs on Friday.",
    outside: true,
  });
  expect(asked[0]?.system).toContain("Today is ");
  expect(asked[0]?.system).toContain("don't fill the gap yourself");
  expect(asked[0]?.prompt).toContain("Question: when does it air?");
  expect(asked[0]?.prompt).toContain("<page>\nThe finale airs Friday.\n</page>");
});

test("only addresses the user gave or a search returned are read unasked", async () => {
  const { tool } = await plugin(async () => page);
  const ask = (url: string) =>
    tool.askFirst?.({ url, question: "q" } as never, {
      tainted: false,
      urls: new Set(["https://a.example/finale"]),
    });
  expect(ask("https://a.example/finale")).toBeUndefined();
  expect(ask("https://a.example/finale#cast")).toBeUndefined();
  expect(ask("https://evil.example/?d=secret")).toBe("an address neither you nor a search gave");
  expect(ask("not a url")).toBe("an address neither you nor a search gave");
});

test("a page that can't be read says why; a turn reads at most five", async () => {
  const { run } = await plugin(async (url) => {
    if (url.includes("down")) throw new PageError("the site answered 503");
    return page;
  });
  expect(await run({ url: "https://down.example/", question: "q" })).toEqual({
    content: "Couldn't read https://down.example/: the site answered 503",
    isError: true,
  });
  for (let i = 0; i < 4; i++) await run({ url: page.url, question: "q" });
  expect(await run({ url: page.url, question: "q" })).toMatchObject({ isError: true });
  // Another session, or the next turn, starts again.
  expect(await run({ url: page.url, question: "q" }, "other")).toMatchObject({ outside: true });
  expect(await run({ url: page.url, question: "q" }, "s", 2)).toMatchObject({ outside: true });
});

/** A network that answers each address from a table, and resolves names to `resolved`. */
function net(pages: Record<string, () => Response>, resolved = ["93.184.216.34"]) {
  const fetched: string[] = [];
  return {
    fetched,
    async fetch(url: URL) {
      fetched.push(url.href);
      const answer = pages[url.href];
      if (!answer) throw new Error(`unexpected fetch ${url.href}`);
      return answer();
    },
    resolve: async () => resolved,
  };
}

const signal = new AbortController().signal;

test("never this machine or its network, however the address is written", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "192.168.1.1",
    "172.20.0.1",
    "169.254.169.254",
    "::1",
  ]) {
    expect(isPrivate(ip)).toBe(true);
  }
  // The forms the URL parser gives IPv6 addresses that lead back to private IPv4 ones.
  for (const ip of [
    "::ffff:7f00:1",
    "::7f00:1",
    "fec0::1",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::",
    "fd00::1",
  ]) {
    expect(isPrivate(ip)).toBe(true);
  }
  for (const ip of ["93.184.216.34", "2606:4700::1111"]) expect(isPrivate(ip)).toBe(false);
  const none = net({});
  for (const url of [
    "http://localhost:4747/",
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://printer.local/",
    "file:///etc/passwd",
  ]) {
    await expect(fetchPage(url, signal, none)).rejects.toBeInstanceOf(PageError);
  }
  // A public name that resolves to a private address.
  await expect(fetchPage("http://sneaky.example/", signal, net({}, ["10.0.0.5"]))).rejects.toThrow(
    "on this machine or its network",
  );
  expect(none.fetched).toEqual([]);
});

test("a redirect is checked like the first address", async () => {
  const n = net({
    "http://93.184.216.34/": () =>
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } }),
  });
  await expect(fetchPage("http://93.184.216.34/", signal, n)).rejects.toThrow(
    "on this machine or its network",
  );
  expect(n.fetched).toEqual(["http://93.184.216.34/"]);
});

test("pages in their own encoding; what isn't text is refused unread", async () => {
  const gbk = new Uint8Array([0x3c, 0x70, 0x3e, 0xc4, 0xe3, 0xba, 0xc3, 0x3c, 0x2f, 0x70, 0x3e]); // <p>你好</p>
  const n = net({
    "https://a.example/gbk": () =>
      new Response(gbk, { headers: { "content-type": "text/html; charset=gbk" } }),
    "https://a.example/meta": () =>
      new Response(new Uint8Array([...new TextEncoder().encode('<meta charset="gbk">'), ...gbk]), {
        headers: { "content-type": "text/html" },
      }),
    "https://a.example/file.pdf": () =>
      new Response("%PDF", { headers: { "content-type": "application/pdf" } }),
  });
  expect((await fetchPage("https://a.example/gbk", signal, n)).text).toBe("你好");
  expect((await fetchPage("https://a.example/meta", signal, n)).text).toBe("你好");
  await expect(fetchPage("https://a.example/file.pdf", signal, n)).rejects.toThrow(
    "isn't a page Ivy can read (application/pdf)",
  );
});

test("a page's title reaches the main model cut short", async () => {
  const { run } = await plugin(async () => ({ ...page, title: "x".repeat(500) }));
  const r = await run({ url: page.url, question: "q" });
  const first = (typeof r === "string" ? r : r.content).split("\n")[0] ?? "";
  expect(first.length).toBeLessThan(160);
});

test("a page's text, without its markup, scripts or navigation", () => {
  expect(
    htmlText(
      "<title>A &amp; B</title><nav>menu</nav><h1>Finale</h1><p>Airs <b>Friday</b>&nbsp;at 9.</p><script>evil()</script><ul><li>one</li><li>two</li></ul>",
    ),
  ).toEqual({ title: "A & B", text: "Finale\nAirs Friday at 9.\none\ntwo" });
  // An entity past the last code point stays as written, rather than failing the read.
  expect(htmlText("<p>&#99999999; &#x1F600;</p>").text).toBe("&#99999999; 😀");
});
