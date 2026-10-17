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
