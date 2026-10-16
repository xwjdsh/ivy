# Ivy — Design Document

> Status: **Draft v0.1** (M0 done; next: M1) · Last updated: 2026-10-16
> This is a living document. Every milestone starts by updating it and ends by recording what changed in the [Decision Log](#13-decision-log).

---

## 1. Overview

Ivy is a **personal AI agent** for one user. It runs locally, talks through the terminal first, and over time learns the user's habits and tools for daily life and work.

The core idea is a **small, stable kernel plus plugins**. The kernel only knows how to:

1. hold a conversation with a model over the Anthropic Messages API,
2. run tools in a loop,
3. load plugins and route their tools, commands, context and jobs,
4. persist sessions and plugin data, and
5. ask the user before risky actions.

Everything users care about (memory, email, calendar, coding help, news digests, ...) is a **plugin**. Adding a new habit or workflow should mean writing a plugin, not changing the core.

## 2. Goals & Non-Goals

### Goals

- **G1 — Useful daily.** Within the first few milestones Ivy should replace some real daily routine (notes, triaging email, a morning brief).
- **G2 — Plugin-first.** Every capability is a plugin with the same API. Built-in plugins get no special access.
- **G3 — Local & owned.** All state lives in plain files under `~/.ivy/` that are easy to read, grep, back up and version.
- **G4 — Safe by default.** Reading is cheap; writing, sending, deleting and shell commands need explicit permission rules or a confirmation.
- **G5 — Iterable.** Small milestones, each one shippable and used before the next one starts.
- **G6 — Cheap to run.** Prompt caching, sensible effort levels, and no wasted tokens.

### Non-Goals (for now)

- Multi-user, accounts, or hosting for others.
- Supporting APIs other than the Anthropic Messages API. Within it, any model works: Claude on Anthropic's API, or any model behind an Anthropic-compatible endpoint (e.g. a local proxy).
- A GUI. (A chat-app bot or local web UI may come later as more *interfaces*, see §5.7.)
- A general-purpose agent framework for other people. Ivy is tuned for one person.

## 3. Guiding Principles

1. **Kernel stays boring.** If a feature can be a plugin, it is a plugin.
2. **Files over databases.** Markdown/JSON/JSONL first; SQLite only where indexing or querying really needs it.
3. **Append-only history.** Conversation transcripts are never rewritten. (This also keeps prompt caching and preserved thinking working correctly.)
4. **Explicit over magic.** Ivy should be able to tell the user which plugin, tool and memory produced an answer.
5. **Confirm before effects.** Any outward-facing or hard-to-reverse action is shown to the user before it runs, unless a permission rule says otherwise.
6. **Dogfood every milestone.** A milestone is only done once it has been used in real life for a few days.
7. **Everything is observable.** Every request, response, tool call, token count and cache hit can be inspected after the fact. If we can't see why Ivy did something, we can't fix it.

## 4. Architecture

```
                ┌──────────────────────────────────────────────┐
                │                  Interfaces                  │
                │   CLI/TUI (M0)   ·   Daemon (M4)   ·   Bot?  │
                └───────────────────────┬──────────────────────┘
                                        │ events / messages
┌───────────────────────────────────────▼───────────────────────────────────────┐
│                                   Ivy Kernel                                   │
│                                                                               │
│  ┌──────────────┐   ┌────────────────┐   ┌─────────────────┐   ┌────────────┐ │
│  │ Session      │   │ Agent Loop     │   │ Context Builder │   │ Permission │ │
│  │ Store        │◄─►│ (tool-use loop)│◄─►│ (system prompt, │   │ Gate       │ │
│  │ (JSONL)      │   │                │   │  plugin context)│   │            │ │
│  └──────────────┘   └───────┬────────┘   └────────▲────────┘   └─────▲──────┘ │
│                             │                     │                  │        │
│                     ┌───────▼────────┐   ┌────────┴──────────────────┴──────┐ │
│                     │ Model Client   │   │           Plugin Host            │ │
│                     │ (Anthropic SDK)│   │ registry · lifecycle · storage   │ │
│                     └───────┬────────┘   │ scheduler · MCP bridge           │ │
│                             │            └────────┬─────────────────────────┘ │
└─────────────────────────────┼─────────────────────┼───────────────────────────┘
                              │                     │
                      Messages API        ┌─────────┴──────────┬──────────────┐
                                          │                    │              │
                                   Native plugins        MCP servers     Config &
                                   (TS modules)          (stdio/http)    data dirs
```

### Request flow (one user turn)

1. The interface sends the user's message to the **Agent Loop** with a session id.
2. The **Context Builder** assembles the request: the frozen system prompt, the tool list from all enabled plugins, the session history, and the new user message, prefixed with a `<context>` block built from plugins' per-turn context (e.g. the current time, relevant memories); see §5.3.
3. The **Model Client** streams the request to the model.
4. If the model calls tools, the loop sends each call through the **Permission Gate**, then to the owning plugin, and appends all results in a single message.
5. Steps 3–4 repeat until the model ends the turn (or a step/budget limit is hit).
6. Every message is appended to the session's JSONL transcript. Plugins get an `afterTurn` hook (e.g. for memory extraction).

## 5. Kernel Components

### 5.1 Agent Loop

- A **manual tool-use loop** that we own (not the SDK's beta Tool Runner). The loop is small, and owning it gives us permission checks, plugin hooks, interruption (Ctrl-C), and step limits in one place.
- Streaming by default; text and tool progress go to the interface as they arrive.
- Parallel tool calls run concurrently; all `tool_result` blocks return in **one** user message. Failed tools return `is_error: true` instead of throwing.
- Limits: `maxSteps` per turn (default 25) and an optional task budget.
- Before running any tool, check `stop_reason` (`max_tokens`, `refusal`) and validate the tool input against its schema.

### 5.2 Model Client

- `@anthropic-ai/sdk`, wrapped in a thin module so the rest of the code never touches raw API shapes.
- Speaks the Anthropic Messages API to whatever `[providers.*]` endpoint is active. With Anthropic's own API the default model is **`claude-opus-5-5`**, with adaptive thinking and `effort` set explicitly per route (e.g. `medium` for chat, `high` for coding tasks, `low` for background jobs like memory extraction or summaries). Configurable per plugin/job.
- Server-side refusal fallback (`fallbacks: "default"`) is on for Anthropic's API; set `refusal_fallback = false` for proxies and other models.
- **Compatible endpoints vary.** Effort, adaptive thinking, prompt caching, refusal fallback, compaction and server tools are Anthropic API features; a compatible endpoint or a non-Claude model may ignore or reject them. Each gets a per-provider switch when a real endpoint needs it (today: `refusal_fallback`; `modelCapabilities` also drops params known models reject).
- **Prompt caching:** tools and system prompt are kept byte-stable (plugins sorted by id, no timestamps), with a cache breakpoint after them. Volatile context (date/time, retrieved memories) goes into the new user message as a `<context>` block (§5.3), never into the system prompt, so the cached prefix stays intact.
- **Switching models:** the active provider's `models` lists what `/model` offers (a picker, or `/model <name>`); the switch lasts for the current run only. Requests only carry params the model accepts (`modelCapabilities`): Haiku gets no `effort` and no refusal fallback, which would be a 400. The prompt cache is per model, so the first call after a switch misses it.
- **Long sessions:** use server-side compaction (beta) when a session grows large, and keep the returned compaction blocks in history.
- **Providers:** `config.toml` can define several `[providers.<name>]` (each with `type`, `api_key`, `base_url`, a required `default_model` used at startup, optional `models` that `/model` can also switch to, and `refusal_fallback`), and `[agent] provider = "<name>"` picks the active one. Only `type = "anthropic"` exists today; another API kind would add a value here plus a `ModelClient`. Generation settings (`effort`, `max_tokens`) live in `[generation]`, independent of the provider.
- Credentials and endpoint come only from `config.toml`. `ANTHROPIC_*` environment variables and `ant` profiles are deliberately ignored, so there is one source of truth. Config is strict: unknown keys are errors.

#### Provider coupling

Ivy speaks only the Anthropic Messages API (see Non-Goals): Claude directly, or any model behind an Anthropic-compatible endpoint. The coupling to that API is kept in known places, so adding another API kind later is a bounded job.

| Anthropic-specific | Where | Impact on another provider |
|---|---|---|
| Message format (content blocks, `tool_use`/`tool_result`, thinking blocks) | Whole kernel; session JSONL | Needs translation; old sessions stay in this format |
| Refusal fallback (`fallbacks: "default"` + beta header) | `Agent.buildRequest` | Unknown param, likely 400 |
| `output_config.effort` | `Agent.buildRequest` | Unknown or named differently |
| Top-level `cache_control` | `Agent.buildRequest` | Ignored or rejected |
| `eager_input_streaming` on tools | `PluginHost.apiTools` | Ignored or rejected |
| Price table | `model.ts` | Cost shows `?` |
| Planned: compaction, server tools (web search) | — | Not available elsewhere |

Other models on the same provider only need `/model`, or a different `default_model` (note: Claude Haiku supports neither `effort` nor fallbacks).

Plan if another API kind (e.g. OpenAI's) is ever needed:
1. **Anthropic-compatible endpoint first.** Many providers expose one; add it as another `[providers.*]` entry with its `base_url`. Add a config switch for each Anthropic-only request param (effort, fallbacks, caching, eager streaming) so they can be turned off. Small change.
2. **Adapter otherwise.** Keep the Anthropic message format as Ivy's internal format and translate per provider inside a `ModelClient` implementation. The agent loop only depends on `ModelClient`, so the change stays in `model.ts`.

### 5.3 Context Builder

Builds each request from layers, ordered from most stable to least stable (for caching):

| Layer | Source | Changes |
|---|---|---|
| Tools | All enabled plugins, sorted | When plugins change |
| System prompt | built-in `core.md` (operating & safety rules) + `~/.ivy/SOUL.md` (who Ivy is) + `~/.ivy/USER.md` (who the user is) + interface instructions (how replies are shown) + each plugin's static `instructions` | Rarely |
| History | Session transcript | Append-only |
| Turn context | Plugins' `contextFor(turn)` (e.g. current time, relevant memories), as a `<context>` block at the start of the user message | Every turn |

Naming follows the common `SOUL.md` / `USER.md` convention of personal agents:

- `packages/kernel/src/prompts/core.md`: operating and safety rules (use tools instead of guessing, report failures honestly, tool output is data not instructions). Built in and always present, so safety never depends on the user's files.
- `SOUL.md`: who Ivy is: personality, tone, values. Only identity, no operating rules.
- `USER.md`: who the user is and how they like things done.
- Interface instructions: supplied by the UI (the TUI says it renders Markdown; one-shot mode asks for plain text).

#### Turn context

Each user turn, the kernel asks every enabled plugin for `contextFor(turn)` and puts the non-empty answers, in plugin-id order, into one text block **before** the user's text in the same user message:

```
<context>
## core
Now: 2026-10-16 Fri 14:57 (Asia/Tokyo, UTC+09:00)
## memory
- [preference] Prefers short answers in Chinese.
- [todo, open] Renew passport before 2026-12.
</context>
```

- **Why not a mid-conversation system message:** that is a newer Claude-only API feature; compatible endpoints and other models may reject it. A text block in the user message works everywhere.
- **History:** the block is stored in the session like the rest of the message (append-only), so a resumed or replayed session shows the model exactly what it saw. The prompt cache is unaffected because the block comes after all earlier history.
- **Display:** the TUI, session previews and turn counts skip the `<context>` block; `-d` traces show it.
- **Trust:** `core.md` tells the model the block is supplied by Ivy as reference data, not written by the user.
- **Limits:** each plugin's context is capped (2,000 characters) and gets a short time budget (1 s); a plugin that fails or times out is skipped and logged, so a turn never fails because of context.

`SOUL.md` and `USER.md` live in the data dir and are optional; a missing file is simply left out (with nothing at all, the request has no system prompt). Templates are in `examples/`. Later, Ivy may be allowed to edit `SOUL.md` itself, with confirmation and history.

### 5.4 Session Store

- One JSONL file per session in `~/.ivy/sessions/YYYY-MM-DD-<id>.jsonl`. Each line is a full API message plus metadata (timestamp, plugin, token usage).
- Crash-tolerant: unparseable lines (a write cut off mid-line) are skipped, the next write starts on a fresh line, and an assistant tool call whose results were never written is dropped on load so the history stays a valid request. A tool call and its results are written in a single append.
- Commands: `ivy -c` continues the most recently active session; `/resume` (or `ivy -r`) opens a picker of recent sessions (last active, first prompt, turn count); `/resume <id>` / `ivy -r <id>` jump directly; `/new` starts a new one. No separate list command.
- Usage (tokens, cache hits, cost estimate) is recorded per turn so we can see what Ivy costs.

### 5.5 Permission Gate

Every tool declares a **risk level**:

| Risk | Examples | Default |
|---|---|---|
| `read` | search memory, read a file, list emails | allow |
| `write` | save a note, edit a local file, create a draft | ask (allowable by rule) |
| `external` | send an email, post a message, accept an invite | always ask |
| `dangerous` | shell commands, deleting data | always ask, show full command |

Rules are tool-name globs (`*` matches anything). Argument patterns such as `shell__run(git status*)` come with the shell plugin in M2.

```toml
[permissions]
allow = ["memory__*"]
deny  = ["gmail__send"]
```

- **Precedence:** `deny` > `allow` > the risk level's default. A denied call is rejected without asking, and the model is told it was denied by a rule.
- **Sources:** rules from `config.toml` (hand-written) plus learned rules in `~/.ivy/permissions.json`, which Ivy owns. Ivy never rewrites `config.toml`, so its comments and layout stay intact.
- **Dialog:** *Yes* / *Yes, for this session* / *Always (saves an allow rule to permissions.json)* / *No*. `dangerous` tools never offer *Always*.
- **Plugin defaults:** a plugin may ship default allow rules for low-impact tools (e.g. memory saves); user `deny` rules still win.

### 5.6 Plugin Host

Loads, configures and runs plugins; see §6 for the plugin contract. Responsibilities:

- Discovery: built-in plugins in `plugins/`, user plugins in `~/.ivy/plugins/`.
- Enable/disable and per-plugin config from `config.toml`: `[plugins.<id>]` holds the plugin's own settings (validated by its `configSchema`) plus `enabled = false` to turn it off. Built-in plugins are on by default.
- Plugin slash commands appear in the `/` list and `/help` next to the built-in ones; a name clash with a built-in command is an error at startup.
- Namespacing: tool names are `<plugin>__<tool>` to avoid collisions (API tool names allow only `[a-zA-Z0-9_-]`, no dots).
- Per-plugin storage directory and secrets access.
- Scheduler for plugin jobs (cron syntax), active once the daemon exists (M4).
- **MCP bridge:** any MCP server listed in config is wrapped as a plugin automatically, so existing MCP servers (Gmail, Calendar, GitHub, ...) are usable with no new code.

### 5.7 Interfaces

An interface turns user I/O into kernel calls. All interfaces share the same kernel API, so adding one does not touch plugins.

- **M0 — TUI** (`ivy`, built with Ink): streamed answers rendered as Markdown, spinner with phase and elapsed time, one-line tool calls with folded results, multi-line input (Shift/Option+Enter or trailing `\`) with persistent history and `/` command completion, permission dialog (once / for this session / deny), status bar (model, effort, session, session token totals); each turn ends with steps, time and tokens. No money in the UI: `/usage` shows token usage for this session, today, the last 7 days and all time (estimated cost is still recorded in session files and shown with `-d`). Esc or Ctrl-C interrupts; Ctrl-C twice or Ctrl-D quits. The real terminal cursor follows the input caret so IME composition (e.g. Chinese) appears in place.
  - Finished paragraphs move into Ink's `<Static>` (printed once, kept in scrollback); only the growing tail re-renders. The live area is capped below the terminal height (older lines shown as "… N more lines above"), because once Ink's dynamic output is taller than the screen it redraws everything on each update and flickers.
  - Redraw (`refresh`): clear Ink's frame and the terminal, then remount `<Static>` with a new key so history reprints. Used by `/new`, `/clear`, `/resume`, Ctrl+L, Ctrl+O and (debounced 100 ms) terminal width changes. Approach borrowed from Gemini CLI.
  - Tool results show 3 lines; Ctrl+O expands the latest turn's tool output (capped at 500 lines) and collapses it again.
  - One-shot mode (`ivy "question"`) stays plain text for scripts and pipes.
- **M4 — Daemon** (`ivy daemon`): runs scheduled jobs and sends results as macOS notifications or files. The CLI can talk to it to see job output.
- **Later (maybe)** — Chat-app bot (Telegram/Slack) for phone access; local web UI.

### 5.8 Tracing & Debugging

Part of the kernel from M0, so problems can be debugged from day one.

- Every API call is written to `~/.ivy/traces/<session>/<time>-<n>.json`: the exact request body, the raw response, latency, and `usage` (input, output, cache read/write tokens). Since each request holds the whole history, traces grow quickly: `[trace] retention_days` (default 7) prunes old session folders on startup, and `[trace] enabled = false` turns tracing off.
- `ivy --debug` prints a compact live view: each loop step, tool calls with inputs/outputs, tokens, cache hit rate, cost.
- `/trace` in the CLI shows the last turn's full request as the model saw it (system prompt, tools, context layers), so prompt and context changes can be checked directly.
- `ivy replay <trace>` re-sends a recorded request, optionally with a changed system prompt, model or effort, to compare outputs. This is the starting point for evals (M2+).

## 6. Plugin System

### 6.1 What a plugin can contribute

| Contribution | Purpose | Example |
|---|---|---|
| `tools` | Functions the model can call | `memory__search`, `gmail__list_threads` |
| `instructions` | Static text added to the system prompt | "Use memory.save when the user states a preference" |
| `contextFor(turn)` | Dynamic text added per turn | Top 5 memories relevant to the message |
| `commands` | Slash commands for the user | `/today`, `/remember <text>` |
| `jobs` | Scheduled tasks (daemon) | Morning brief at 08:30 on weekdays |
| `hooks` | Lifecycle callbacks | `onSessionStart`, `afterTurn`, `beforeToolCall` |

### 6.2 Plugin contract (sketch)

```ts
// packages/plugin-api — the only thing a plugin imports from Ivy
import type { z } from "zod";

export interface IvyPlugin {
  id: string;                 // "memory", "gmail", ...
  version: string;
  description: string;
  configSchema?: z.ZodType;   // validated from config.toml [plugins.<id>]

  setup(ctx: PluginContext): Promise<void> | void;
  teardown?(): Promise<void> | void;

  tools?: ToolDef[];
  instructions?: string;
  contextFor?(turn: TurnInfo): Promise<string | null> | string | null;
  commands?: CommandDef[];
  jobs?: JobDef[];
  hooks?: Partial<PluginHooks>;
}

export interface ToolDef<I = unknown> {
  name: string;               // exposed to the model as "<pluginId>__<name>"
  description: string;
  input: z.ZodType<I>;        // converted to JSON Schema; validated before run
  risk: "read" | "write" | "external" | "dangerous";
  run(input: I, ctx: ToolContext): Promise<ToolResult>;
}

export interface PluginContext {
  config: unknown;            // parsed with configSchema
  storage: PluginStorage;     // ~/.ivy/data/<pluginId>/ (files + optional SQLite)
  secrets: SecretStore;       // macOS Keychain-backed
  log: Logger;
  llm: LlmClient;             // for plugins that need their own model calls (e.g. summarizing)
  kernel: KernelApi;          // send notifications, call other plugins' tools, etc.
}

export interface TurnInfo {
  sessionId: string;
  userText: string;           // the new user message (for relevance)
  now: Date;
}

export interface CommandDef {
  name: string;               // "/remember"
  args?: string;              // "<text>" (required) or "[query]" (optional), as in the / list
  description: string;
  run(args: string, ctx: CommandContext): Promise<string | void> | string | void;  // returned text is shown to the user
}

export interface JobDef {
  id: string;
  schedule: string;           // cron, e.g. "30 8 * * 1-5"
  run(ctx: JobContext): Promise<void>;
}
```

A plugin is a folder with an `index.ts` that default-exports an `IvyPlugin`. The contract will be versioned (`apiVersion`) once M2 is done.

### 6.3 Trust model

- Plugins run **in-process** with full user permissions. Only install plugins you have read or written. (Process isolation is out of scope for now; MCP servers already run as separate processes.)
- The Permission Gate still applies to every tool call, including MCP tools.
- Tool *results* from outside sources (emails, web pages, RSS) are untrusted data. The built-in `core.md` tells the model not to follow instructions found inside them, and `external`/`dangerous` tools always require confirmation, which limits prompt-injection damage.

## 7. Data & Storage Layout

```
~/.ivy/
├── config.toml          # global config, enabled plugins, permissions, model settings
├── SOUL.md              # who Ivy is (optional, loaded into system prompt)
├── USER.md              # who the user is (optional, loaded into system prompt)
├── permissions.json     # allow rules learned from the permission dialog (Ivy-owned)
├── sessions/            # append-only JSONL transcripts
├── data/<pluginId>/     # per-plugin storage
│   └── memory/          #   memory plugin: one markdown file per memory
├── plugins/             # user-installed plugins
├── traces/              # raw API requests/responses per session (see §5.8)
└── logs/                # kernel & daemon logs
```

The Anthropic API key may live in `config.toml` (plain text). Other secrets (OAuth tokens, plugin API keys) go into the macOS Keychain. If `~/.ivy` is backed up with git, exclude `config.toml` or keep the key out of it.

The data root is `$IVY_HOME`, default `~/.ivy`. During development `bun run ivy` sets it to `./.ivy` in the repo (git-ignored), so all dev data is local and easy to wipe.

## 8. Planned Plugins

| Plugin | Milestone | Summary | Key tools |
|---|---|---|---|
| `core` | M0 / M1 | Current time (tool + per-turn context), date arithmetic | `now`, `date_calc` |
| `memory` | M1 | Long-term preferences, facts, todos and notes as markdown files; relevant ones injected each turn (§8.1) | `save`, `search`, `list`, `update`, `delete` |
| `fs` + `shell` | M2 | Read/edit files and run commands in allowed directories — the coding/work helper | `read`, `write`, `edit`, `glob`, `grep`, `run` |
| `mcp` bridge | M2 | Wraps configured MCP servers as plugins | (from servers) |
| `gmail` / `calendar` | M3 | Triage, summarize, draft replies, today's agenda — via MCP servers or Google APIs | `search`, `read_thread`, `draft`, `agenda` |
| `web` | M3 | Web search & fetch (Anthropic server tools on Anthropic's API; otherwise a client-side tool) | `search`, `fetch` |
| `digest` | M4 | Scheduled brief from RSS / GitHub / email / calendar | job `morning-brief` |

### 8.1 Memory plugin

**Storage.** One markdown file per memory in `~/.ivy/data/memory/`, the source of truth, readable and editable by hand, and easy to back up with git:

```markdown
---
id: 2026-10-16-a1b2c3
type: todo            # preference | fact | todo | note
tags: [travel]
status: open          # todos only: open | done
created: 2026-10-16T14:57:00+09:00
updated: 2026-10-16T14:57:00+09:00
---
Renew passport before 2026-12.
```

**Search.** All memories are loaded into memory at startup (and reloaded when files change). Relevance is a simple keyword score: words for Latin text, character bigrams for CJK (so Chinese matches without a word segmenter), plus a small recency boost. A personal memory store stays small (hundreds to a few thousand entries), so a linear scan is fast enough. SQLite FTS or embeddings can replace it later behind the same `search` function.

**Writing.** The model saves memories with tools, guided by the plugin's `instructions`: save durable preferences, facts and todos (or when the user says "remember"); don't save one-off details; search first and update instead of duplicating. The user can save directly with `/remember`. Automatic extraction after each turn is a later, opt-in addition (backlog).

**Reading.** `contextFor` injects the top 5 memories relevant to the new message (above a minimum score) into the turn's `<context>` block. The model can also call `memory__search` / `memory__list` for more.

**Tools and permissions.**

| Tool | Risk | Default |
|---|---|---|
| `save(content, type, tags?)` | write | allowed (plugin default rule) |
| `search(query, type?, limit?)` | read | allowed |
| `list(type?, status?)` | read | allowed |
| `update(id, content?, tags?, status?)` | write | allowed (plugin default rule) |
| `delete(id)` | write | asks |

**Commands.** `/remember <text>` saves a note as-is; `/memory [query]` lists recent memories or searches.

## 9. Project Layout

Bun workspace monorepo:

```
ivy/
├── docs/
│   ├── DESIGN.md            # this file
│   └── adr/                 # one file per significant decision (optional)
├── evals/                   # eval cases and runner (from M2)
├── packages/
│   ├── kernel/              # loop, model client, context, sessions, permissions, plugin host
│   ├── plugin-api/          # public types for plugin authors
│   └── cli/                 # `ivy` command (TUI + one-shot)
├── plugins/
│   ├── core/
│   ├── memory/
│   └── ...
├── package.json
├── tsconfig.json
└── bun.lock
```

## 10. Tech Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | Bun | Fast startup for a CLI, built-in TS, test runner, SQLite (`bun:sqlite`), can compile to a single binary |
| Language | TypeScript (strict) | Types for the plugin contract |
| LLM API | Anthropic Messages API via `@anthropic-ai/sdk`; default model Claude Opus 5.5 | One wire format; works with Claude and any Anthropic-compatible endpoint |
| Schemas | Zod | Tool inputs, config validation, JSON Schema generation |
| MCP | `@modelcontextprotocol/sdk` | MCP bridge plugin |
| TUI | Ink 8 + marked-terminal | Mature (used by Claude Code, Gemini CLI); `<Static>` for scrollback |
| Config | TOML | Easy to hand-edit |
| Tests | `bun test` | Built in |
| Lint/format | Biome | One fast tool |

**Alternative considered:** building on the Claude Agent SDK (Claude Code as a library). It gives file/shell tools and a loop for free, but it is coding-centric and makes the plugin model, context layering and permission UX harder to own. We build our own small kernel and may borrow ideas from it.

## 11. Roadmap

Each milestone ends with a few days of real use and an update to this doc.

### M0 — Hello, Ivy (walking skeleton)
- Bun workspace, `ivy` CLI, config loading, API auth.
- Streaming chat with the model, multi-turn, JSONL sessions (`/new`, `/resume`).
- Agent loop with the `core` plugin (`now` tool) to prove tool calling end-to-end.
- Token usage & cost shown per turn.
- Tracing v1: raw request/response files + `--debug` live view (§5.8).
- **Done when:** I can chat with Ivy in the terminal and resume yesterday's session.
- **Status: done (2026-10-16).** Shipped beyond the plan: Ink TUI (see §5.7), `/usage`, `bun run build` single binary, CI.
- **Deferred:** `/trace` and `ivy replay` (§5.8) → M2 with evals; server-side compaction for long sessions → when sessions get long; large-paste placeholders and a custom Markdown renderer → backlog; progress updates while thinking (`thinking.display: "updates"`) → M1.

### M1 — Memory
Goal: Ivy starts remembering. Built in this order; each step is shippable on its own.

1. **Plugin host v1:** `contextFor` → `<context>` block (§5.3), plugin slash commands, `[plugins.<id>] enabled` and per-plugin config validation.
   *Done when:* a test plugin's context reaches the model, its command shows in the `/` list, and disabling it removes both.
2. **core plugin:** per-turn current time in context; `date_calc` tool (difference between dates, add/subtract days/weeks/months, weekday of a date, timezone conversion).
   *Done when:* "what's the date next Wednesday?" is answered in one model call without calling `now`.
3. **Permission rules:** `[permissions]` allow/deny globs, `permissions.json` learned rules, *Always* in the dialog, plugin default rules (§5.5).
   *Done when:* a tool allowed with *Always* isn't asked about after a restart, and a `deny` rule beats every allow.
4. **memory plugin** (§8.1): files, keyword search incl. CJK, tools, instructions, per-turn context, `/remember`, `/memory`.
   *Done when:* a preference or todo mentioned in one session is used, unprompted, in a later one.
5. *(Optional)* Progress notes while the model works (`thinking.display: "updates"`), only where the provider supports it.

`USER.md` in the system prompt (originally listed here) shipped in M0.

- **Done when (milestone):** Ivy remembers facts and todos across sessions and uses them without being asked.

### M2 — Work helper
- `fs` + `shell` plugins with directory allowlist and permission rules.
- MCP bridge plugin.
- Plugin API frozen as `apiVersion: 1`; user plugins from `~/.ivy/plugins/`.
- Evals v1: a small set of real cases (from traces) for memory and tool use, runnable with `bun run eval`, so prompt/model changes can be measured instead of guessed.
- **Done when:** I use Ivy for at least one real work task per day.

### M3 — Email & Calendar
- Gmail + Calendar (MCP first; native plugin only if MCP is not good enough).
- `/inbox` triage summary, draft replies (never auto-send), `/today` agenda.
- `web` plugin.
- **Done when:** morning inbox triage happens in Ivy.

### M4 — Daemon & Digest
- `ivy daemon` (launchd service), scheduler, macOS notifications.
- `digest` plugin: morning brief combining calendar, inbox, todos, feeds.
- **Done when:** a useful brief is waiting every weekday morning.

### M5+ — Ideas backlog
- Chat-app interface for phone access.
- Semantic (embedding) search for memory.
- Automatic memory extraction (opt-in) and periodic memory cleanup.
- Memory search on SQLite FTS or embeddings if the keyword scan gets slow or misses too much.
- Usage dashboard; per-plugin effort/model tuning.
- Subagents for fan-out research tasks.
- TUI: collapse large pastes into `[Pasted text: N lines]` placeholders; own Markdown renderer (lowlight code highlighting, width-aware tables) if marked-terminal falls short.

## 12. Open Questions

1. ~~**TUI library**~~ → Ink (decided in M0).
2. ~~**Memory format**~~ → one markdown file per memory; written by the model via tools plus `/remember`; auto-extraction later and opt-in (decided for M1, §8.1).
3. **Email/calendar:** MCP servers vs. direct Google API plugins (OAuth handling, offline access for the daemon)? → decide in M3.
4. **Notifications:** macOS notifications only, or also push to phone? → decide in M4.
5. **Language of conversation:** Ivy's code and docs are English; should Ivy reply in the language I write in (Chinese/English)? Default: yes, mirror the user.

## 13. Decision Log

| Date | Decision | Reason |
|---|---|---|
| 2026-10-16 | TypeScript + Bun | Fast CLI startup, built-in SQLite & tests, good SDK/MCP support |
| 2026-10-16 | Terminal CLI is the first interface | Closest to daily dev workflow; other interfaces later |
| 2026-10-16 | ~~Claude only~~ (superseded below), default `claude-opus-5-5` | Simplicity; best tool use |
| 2026-10-16 | All capabilities are plugins | Kernel stays small; habits change by adding plugins |
| 2026-10-16 | Own tool-use loop, not Agent SDK | Full control over plugins, permissions, context |
| 2026-10-16 | Project content in English | User preference |
| 2026-10-16 | Claude writes the code, user reviews it | User's choice; small, reviewable changes |
| 2026-10-16 | Tool names `<plugin>__<tool>` | API tool names cannot contain dots |
| 2026-10-16 | API key and base URL only from `config.toml` | One source of truth; env vars ignored; user's choice |
| 2026-10-16 | Scope is the Anthropic Messages API, not Claude: any model behind an Anthropic-compatible endpoint | The user runs a local proxy with a non-Claude model |
| 2026-10-16 | Config: `[providers.*]` + `[agent] provider` selector, `[generation]`, strict keys | Room for proxies / other API kinds; typos and stale keys fail loudly |
| 2026-10-16 | Dev data in `./.ivy` | Easy to inspect and wipe during development |
| 2026-10-16 | Prompt files named `SOUL.md` / `USER.md`, both read from the data dir, empty if missing | Common convention for personal agents; easy to edit without touching code |
| 2026-10-16 | No provider abstraction yet; coupling documented in §5.2 | Avoid premature abstraction; switching path is known |
| 2026-10-16 | Ink TUI for interactive mode; plain text for one-shot | Rich UI where it helps, script-friendly output elsewhere |
| 2026-10-16 | Built-in `core.md` for operating/safety rules; SOUL.md is identity only; UI supplies format instructions | Rules must not depend on user files; personality and presentation stay separate |
| 2026-10-16 | Per-turn context as a `<context>` block in the user message, not a mid-conversation system message | Works on every Anthropic-compatible endpoint and model; stored in history for faithful replay |
| 2026-10-16 | Memory: markdown file per memory, in-memory keyword scoring with CJK bigrams, no SQLite in v1 | Human-editable source of truth; Chinese works without a segmenter; small data |
| 2026-10-16 | Memories written by the model via tools (+ `/remember`); auto-extraction later, opt-in | Fewer junk memories; no extra model call per turn |
| 2026-10-16 | Learned permission rules go to `permissions.json`, not `config.toml` | Never rewrite the user's hand-edited config |
| 2026-10-16 | Use the beta Messages API (`client.beta.messages`) | Needed for `fallbacks: "default"` now and compaction later |
