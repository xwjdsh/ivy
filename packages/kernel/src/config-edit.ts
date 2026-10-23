import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Config, type Effort, loadConfig, type Paths } from "./config.ts";
import { errorMessage } from "./log.ts";

/**
 * Small in-place edits to config.toml: one `key = value` line in one section is replaced
 * (or added), so the user's comments and layout survive (there is no TOML writer that
 * keeps them). Every edit is re-validated; on any problem the file is left as it was.
 */

/** Save `/model`'s choice, "<provider>/<model id>", as `[agent] model`. */
export function saveModel(paths: Paths, model: string): Config {
  return saveEdit(
    paths,
    (toml) => withValue(toml, ["agent"], "model", model, { createSection: true }),
    (c) => c.model?.ref === model,
    "the model",
  );
}

/** Save the helper model, `[agent] helper_model`; none takes it out, so side work runs on the main model. */
export function saveHelperModel(paths: Paths, model: string | undefined): Config {
  return saveEdit(
    paths,
    (toml) =>
      model
        ? withValue(toml, ["agent"], "helper_model", model, { createSection: true })
        : withoutKey(toml, ["agent"], "helper_model"),
    (c) => c.agent.helper_model === model,
    "the helper model",
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

/** A provider's name: a bare TOML key, and never a "/" (models are "<provider>/<id>"). */
export const PROVIDER_NAME = /^[A-Za-z0-9_-]+$/;

export interface ProviderEdit {
  base_url?: string;
  /** Models offered on it; empty: whatever its endpoint lists. */
  models?: string[];
}

/** Add `[providers.<name>]` at the end of config.toml. */
export function addProvider(
  paths: Paths,
  name: string,
  provider: { type: string } & ProviderEdit,
): Config {
  if (!PROVIDER_NAME.test(name)) {
    throw new Error("A provider's name is letters, digits, - and _");
  }
  return saveEdit(
    paths,
    (toml) => {
      if (tableRange(toml.split("\n"), ["providers", name])) {
        throw new Error(`There is a provider named ${name} already`);
      }
      const entries: string[] = [`type = ${JSON.stringify(provider.type)}`];
      if (provider.base_url) entries.push(`base_url = ${JSON.stringify(provider.base_url)}`);
      if (provider.models?.length) entries.push(`models = ${tomlList(provider.models)}`);
      return withTable(toml, ["providers", name], entries);
    },
    (c) => name in c.providers,
    "the provider",
  );
}

/** Change a provider's endpoint or models, each on its own line. */
export function updateProvider(paths: Paths, name: string, edit: ProviderEdit): Config {
  const section = ["providers", name];
  return saveEdit(
    paths,
    (toml) => {
      let next = toml;
      if (edit.base_url !== undefined) {
        next = edit.base_url
          ? withValue(next, section, "base_url", edit.base_url)
          : withoutKey(next, section, "base_url");
      }
      if (edit.models !== undefined) {
        next = edit.models.length
          ? withRaw(next, section, "models", tomlList(edit.models))
          : withoutKey(next, section, "models");
      }
      return next;
    },
    (c) => name in c.providers,
    "the provider",
  );
}

/** Remove `[providers.<name>]`: its header and its lines, nothing else. */
export function removeProvider(paths: Paths, name: string): Config {
  return saveEdit(
    paths,
    (toml) => withoutTable(toml, ["providers", name]),
    (c) => !(name in c.providers),
    "the provider",
  );
}

/** Remove a provider's `api_key` line, once its key has moved to the Keychain. */
export function removeApiKey(paths: Paths, name: string): Config {
  return saveEdit(
    paths,
    (toml) => withoutKey(toml, ["providers", name], "api_key"),
    (c) => c.providers[name]?.api_key === undefined,
    "the provider",
  );
}

const tomlList = (values: string[]) => `[${values.map((v) => JSON.stringify(v)).join(", ")}]`;

function saveEdit(
  paths: Paths,
  edit: (toml: string) => string,
  applied: (config: Config) => boolean,
  what: string,
): Config {
  // A new install has no file yet: the first edit writes it.
  const existed = existsSync(paths.config);
  const original = existed ? readFileSync(paths.config, "utf8") : "";
  mkdirSync(dirname(paths.config), { recursive: true });
  writeFileSync(paths.config, edit(original));
  try {
    const config = loadConfig(paths);
    if (!applied(config)) throw new Error("the edit did not take effect");
    return config;
  } catch (err) {
    if (existed) writeFileSync(paths.config, original);
    else rmSync(paths.config, { force: true });
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

/**
 * Lines `[start, end)` of the table at `section`: its header and every line up to the next
 * header. The blank lines and comments just above the next header belong to that one, so
 * removing a table leaves the next table's comment where it was.
 */
function tableRange(lines: string[], section: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((line) => sameTable(headerPath(line), section));
  if (start === -1) return null;
  let end = lines.findIndex((line, i) => i > start && headerPath(line) !== null);
  if (end === -1) end = lines.length;
  while (end > start + 1 && /^\s*(#.*)?$/.test(lines[end - 1] ?? "")) end--;
  return { start, end };
}

/** Pure text edit: append the table `[section]` with `entries`, one per line. */
export function withTable(toml: string, section: string[], entries: string[]): string {
  const body = toml.endsWith("\n") || toml === "" ? toml : `${toml}\n`;
  return `${body}${body.trim() ? "\n" : ""}[${section.join(".")}]\n${entries.join("\n")}\n`;
}

/**
 * Pure text edit: remove the table `[section]` with the comment just above its header, and
 * the blank line that set it apart.
 */
export function withoutTable(toml: string, section: string[]): string {
  const lines = toml.split("\n");
  const range = tableRange(lines, section);
  if (!range) throw new Error(`No [${section.join(".")}] section in config.toml`);
  let { start } = range;
  while (start > 0 && /^\s*#/.test(lines[start - 1] ?? "")) start--;
  if (start > 0 && (lines[start - 1] ?? "").trim() === "") start--;
  lines.splice(start, range.end - start);
  return lines.join("\n");
}

/** Pure text edit: remove `key` from `[section]`, a list over several lines included. */
export function withoutKey(toml: string, section: string[], key: string): string {
  const lines = toml.split("\n");
  const range = tableRange(lines, section);
  if (!range) throw new Error(`No [${section.join(".")}] section in config.toml`);
  const at = keyLineIn(lines, range, key);
  if (at === -1) return toml;
  lines.splice(at, valueEnd(lines, at) - at + 1);
  return lines.join("\n");
}

/**
 * Pure text edit: set `key` in `[section]` to `value`, already TOML (a list), replacing its
 * line or lines; a missing key goes right after the header.
 */
export function withRaw(toml: string, section: string[], key: string, value: string): string {
  const lines = toml.split("\n");
  const range = tableRange(lines, section);
  if (!range) throw new Error(`No [${section.join(".")}] section in config.toml`);
  const rendered = `${key} = ${value}`;
  const at = keyLineIn(lines, range, key);
  if (at === -1) lines.splice(range.start + 1, 0, rendered);
  else lines.splice(at, valueEnd(lines, at) - at + 1, rendered);
  return lines.join("\n");
}

function keyLineIn(lines: string[], range: { start: number; end: number }, key: string): number {
  const keyLine = new RegExp(`^\\s*${key}\\s*=`);
  for (let i = range.start + 1; i < range.end; i++) {
    if (keyLine.test(lines[i] ?? "")) return i;
  }
  return -1;
}

/** The last line of the value that starts on line `at`: a list may close lines later. */
function valueEnd(lines: string[], at: number): number {
  const code = codeOf(lines[at] as string);
  if (!/=\s*\[/.test(code)) return at;
  return closingBracket(lines, at)?.line ?? at;
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
