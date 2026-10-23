// Fetching a page for Ivy to read: public http(s) addresses only, a few redirects, a size
// cap, and HTML turned into its text.

import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/** What is read of a page at most; the rest is cut off. */
const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

export interface Page {
  /** Where the page was found, after redirects. */
  url: string;
  title: string;
  text: string;
}

/** Why a page couldn't be read, in words for the model. */
export class PageError extends Error {}

/** How a page is fetched and a name looked up: the network's own, or a test's. */
export interface Net {
  fetch(url: URL, init: RequestInit): Promise<Response>;
  /** The addresses a name resolves to. */
  resolve(host: string): Promise<string[]>;
}

const NET: Net = {
  fetch: (url, init) => fetch(url, init),
  resolve: async (host) => (await lookup(host, { all: true })).map((a) => a.address),
};

export async function fetchPage(address: string, signal: AbortSignal, net = NET): Promise<Page> {
  let url = new URL(address);
  for (let hop = 0; ; hop++) {
    await checkPublic(url, net);
    const res = await net.fetch(url, {
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; Ivy)",
        accept: "text/html,text/plain;q=0.9,*/*;q=0.5",
      },
    });
    const next = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && next) {
      await res.body?.cancel();
      // Each hop is checked again: a public page may send Ivy to a private one.
      if (hop >= MAX_REDIRECTS) throw new PageError("too many redirects");
      url = new URL(next, url);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new PageError(`the site answered ${res.status}`);
    }
    const type = res.headers.get("content-type") ?? "";
    const html = type.includes("html");
    if (!html && !type.startsWith("text/") && !type.includes("json") && !type.includes("xml")) {
      await res.body?.cancel();
      throw new PageError(`it isn't a page Ivy can read (${type.split(";")[0] || "unknown type"})`);
    }
    const body = decode(await readCapped(res), type, html);
    return html ? { url: url.href, ...htmlText(body) } : { url: url.href, title: "", text: body };
  }
}

/**
 * Only public addresses: never the user's own machine or network, which a page or the model
 * could otherwise point Ivy at. The name is looked up, so a public name for a private address
 * is refused too. Not covered: a name that answers this lookup with a public address and the
 * fetch's own with a private one (DNS rebinding), as the fetch can't be held to an address.
 */
async function checkPublic(url: URL, net: Net): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PageError("only http and https addresses can be read");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || /\.(localhost|local|internal|lan|home)$/.test(host)) {
    throw new PageError("that address is on this machine or its network");
  }
  const addresses = isIP(host)
    ? [host]
    : await net.resolve(host).catch(() => {
        throw new PageError(`no such site: ${host}`);
      });
  if (addresses.some(isPrivate)) {
    throw new PageError("that address is on this machine or its network");
  }
}

/**
 * Addresses that aren't the public internet: this machine, private networks, link-local
 * (cloud metadata), and the IPv6 forms that lead back to them (IPv4-mapped, NAT64, 6to4).
 */
const PRIVATE = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const) {
  PRIVATE.addSubnet(net, bits, "ipv4");
}
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["64:ff9b::", 96],
  ["2002::", 16],
] as const) {
  PRIVATE.addSubnet(net, bits, "ipv6");
}

export function isPrivate(ip: string): boolean {
  const family = isIP(ip);
  if (!family) return true;
  return PRIVATE.check(ip, family === 6 ? "ipv6" : "ipv4");
}

async function readCapped(res: Response): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).subarray(0, MAX_BYTES);
}

/**
 * Bytes as text in the page's own encoding (pages in Chinese or Japanese are often not
 * UTF-8): the header's charset, else an HTML page's <meta>, else UTF-8.
 */
function decode(bytes: Uint8Array, type: string, html: boolean): string {
  const head = html ? new TextDecoder("latin1").decode(bytes.subarray(0, 2048)) : "";
  const label =
    type.match(/charset=["']?([\w-]+)/i)?.[1] ??
    head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
  try {
    return new TextDecoder(
      (label ?? "utf-8") as ConstructorParameters<typeof TextDecoder>[0],
    ).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

/** Elements that are not what a page says. */
const SKIPPED = [
  "script",
  "style",
  "noscript",
  "svg",
  "template",
  "iframe",
  "nav",
  "footer",
  "form",
];
/** Elements that end a line of text. */
const BLOCKS = /^(p|div|br|li|h[1-6]|tr|section|article|header|blockquote|pre|dd|dt|table|ul|ol)$/;

/** A page's title and text, without markup, scripts or navigation. */
export function htmlText(html: string): { title: string; text: string } {
  let title = "";
  let inTitle = false;
  let skipping = 0;
  const parts: string[] = [];
  const rewriter = new HTMLRewriter()
    .on("title", {
      element(el) {
        inTitle = true;
        el.onEndTag(() => {
          inTitle = false;
        });
      },
    })
    .on(SKIPPED.join(","), {
      element(el) {
        skipping++;
        el.onEndTag(() => {
          skipping--;
        });
      },
    })
    .on("*", {
      element(el) {
        if (BLOCKS.test(el.tagName)) parts.push("\n");
      },
      text(chunk) {
        if (inTitle) title += chunk.text;
        else if (!skipping) parts.push(chunk.text);
      },
    });
  rewriter.transform(html);
  const text = decodeEntities(parts.join(""))
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/ *\n[\n ]*/g, "\n")
    .trim();
  return { title: decodeEntities(title).trim(), text };
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code =
        name[1]?.toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}
