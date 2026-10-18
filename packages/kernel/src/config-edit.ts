import { readFileSync, writeFileSync } from "node:fs";
import { type Config, type Effort, loadConfig, type Paths } from "./config.ts";
import { errorMessage } from "./log.ts";

/**
 * Small in-place edits to config.toml: one `key = value` line in one section is replaced
 * (or added), so the user's comments and layout survive (there is no TOML writer that
 * keeps them). Every edit is re-validated; on any problem the file is left as it was.
 */

/** Save `/model`'s choice as the provider's `default_model`. */
export function saveDefaultModel(paths: Paths, provider: string, model: string): Config {
  return saveEdit(
    paths,
    (toml) => withValue(toml, ["providers", provider], "default_model", model),
    (c) => c.providers[provider]?.default_model === model,
    "default_model",
  );
}

/** Save `/effort`'s choice as `[generation] effort`. */
export function saveEffort(paths: Paths, effort: Effort): Config {
  return saveEdit(
    paths,
    (toml) => withValue(toml, ["generation"], "effort", effort, { createSection: true }),
    (c) => c.generation.effort === effort,
    "effort",
  );
}

/** Save an *Always* from the permission prompt: add `tool` to `[permissions] allow`. */
export function saveAllowRule(paths: Paths, tool: string): Config {
  return saveEdit(
    paths,
    (toml) => withListItem(toml, ["permissions"], "allow", tool),
    (c) => c.permissions.allow.includes(tool),
    "the allow rule",
  );
}

function saveEdit(
  paths: Paths,
  edit: (toml: string) => string,
  applied: (config: Config) => boolean,
  what: string,
): Config {
  const original = readFileSync(paths.config, "utf8");
  writeFileSync(paths.config, edit(original));
  try {
    const config = loadConfig(paths);
    if (!applied(config)) throw new Error("the edit did not take effect");
    return config;
  } catch (err) {
    writeFileSync(paths.config, original);
    throw new Error(`Could not save ${what}: ${errorMessage(err)}`);
  }
}

/**
 * Pure text edit: set a string `key` inside the `[section.path]` table. Replaces the value
 * on an existing line (keeping any trailing comment), else inserts the line right after
 * the header; with `createSection`, a missing table is appended at the end.
 */
export function withValue(
  toml: string,
  section: string[],
  key: string,
  value: string,
  options: { createSection?: boolean } = {},
): string {
  const lines = toml.split("\n");
  const header = lines.findIndex((line) => sameTable(headerPath(line), section));
  const rendered = `${key} = ${JSON.stringify(value)}`;

  if (header === -1) {
    if (!options.createSection) throw new Error(`No [${section.join(".")}] section in config.toml`);
    const body = toml.endsWith("\n") || toml === "" ? toml : `${toml}\n`;
    return `${body}${body.trim() ? "\n" : ""}[${section.join(".")}]\n${rendered}\n`;
  }

  let end = lines.findIndex((line, i) => i > header && headerPath(line) !== null);
  if (end === -1) end = lines.length;

  const keyLine = new RegExp(`^(\\s*${key}\\s*=\\s*)("(?:[^"\\\\]|\\\\.)*"|'[^']*')(.*)$`);
  for (let i = header + 1; i < end; i++) {
    const match = keyLine.exec(lines[i] ?? "");
    if (match) {
      lines[i] = `${match[1]}${JSON.stringify(value)}${match[3]}`;
      return lines.join("\n");
    }
  }
  lines.splice(header + 1, 0, rendered);
  return lines.join("\n");
}

/** `[a.b]`, `[ a . "b.c" ]` → ["a", "b.c"]; null for lines that aren't table headers. */
function headerPath(line: string): string[] | null {
  const match = /^\s*\[([^[\]]+)\]\s*(#.*)?$/.exec(line);
  if (!match?.[1]) return null;
  const parts = match[1].match(/"[^"]*"|'[^']*'|[^.\s]+/g) ?? [];
  return parts.map((p) => p.replace(/^["']|["']$/g, ""));
}

function sameTable(path: string[] | null, section: string[]): boolean {
  return path !== null && path.length === section.length && path.every((p, i) => p === section[i]);
}

/**
 * Pure text edit: add `value` to the string list `key` inside `[section.path]`, keeping the
 * list's layout and comments: inserted before the closing `]`, on its own line when the
 * list spans several lines. A missing key is added after the header, a missing table at
 * the end. Doesn't check for duplicates; callers do.
 */
export function withListItem(toml: string, section: string[], key: string, value: string): string {
  const lines = toml.split("\n");
  const item = JSON.stringify(value);
  const header = lines.findIndex((line) => sameTable(headerPath(line), section));
  if (header === -1) {
    const body = toml.endsWith("\n") || toml === "" ? toml : `${toml}\n`;
    return `${body}${body.trim() ? "\n" : ""}[${section.join(".")}]\n${key} = [${item}]\n`;
  }
  let end = lines.findIndex((line, i) => i > header && headerPath(line) !== null);
  if (end === -1) end = lines.length;
  const start = lines.findIndex(
    (line, i) => i > header && i < end && new RegExp(`^\\s*${key}\\s*=\\s*\\[`).test(line),
  );
  if (start === -1) {
    lines.splice(header + 1, 0, `${key} = [${item}]`);
    return lines.join("\n");
  }

  const close = closingBracket(lines, start);
  if (!close) throw new Error(`Can't find the end of ${key} in [${section.join(".")}]`);
  const line = lines[close.line] as string;
  const before = line.slice(0, close.col);
  const open = close.line === start ? before.indexOf("[") : -1;
  const inside = close.line === start ? before.slice(open + 1) : before;

  if (inside.trim() !== "" || close.line === start) {
    // Items on the same line as `]`: insert there ("a"] → "a", "new"]).
    const trimmed = before.trimEnd();
    const empty = inside.trim() === "";
    const sep = empty || trimmed.endsWith(",") ? (empty ? "" : " ") : ", ";
    lines[close.line] = `${trimmed}${sep}${item}${line.slice(close.col)}`;
    return lines.join("\n");
  }
  // `]` on its own line: add a line above it, after a comma on the last item if needed.
  let last = close.line - 1;
  while (last > start && codeOf(lines[last] as string).trim() === "") last--;
  const lastLine = lines[last] as string;
  const code = codeOf(lastLine).trimEnd();
  if (last > start && !code.endsWith(",")) {
    lines[last] = `${code},${lastLine.slice(code.length)}`;
  }
  const indent = last > start ? (/^\s*/.exec(lastLine)?.[0] ?? "  ") : "  ";
  lines.splice(close.line, 0, `${indent}${item},`);
  return lines.join("\n");
}

/** Where the list opened on line `start` closes: brackets in strings and comments don't count. */
function closingBracket(lines: string[], start: number): { line: number; col: number } | null {
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    const text = lines[i] as string;
    let quote: string | null = null;
    for (let j = 0; j < text.length; j++) {
      const ch = text[j];
      if (quote) {
        if (ch === "\\" && quote === '"') j++;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "#") break;
      else if (ch === "[") depth++;
      else if (ch === "]" && --depth === 0) return { line: i, col: j };
    }
  }
  return null;
}

/** A line without its comment (a `#` outside strings). */
function codeOf(line: string): string {
  let quote: string | null = null;
  for (let j = 0; j < line.length; j++) {
    const ch = line[j];
    if (quote) {
      if (ch === "\\" && quote === '"') j++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#") return line.slice(0, j);
  }
  return line;
}
