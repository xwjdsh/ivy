# Ivy — Design Document

> Status: **Draft v0.1** (M0 done; M1 built and its acceptance checks passed; next: a few days of real use, then M2) · Last updated: 2026-10-19
> This is a living document. Every milestone starts by updating it and ends by recording what changed in the [Decision Log](#13-decision-log).

---

## 1. Overview

Ivy is a **personal AI agent** for one user. It runs locally, talks through the terminal first, and over time learns the user's habits and tools for daily life and work. It is meant to be someone to the user, not just a tool: it has a character (written by the user in `SOUL.md`) and carries what it has lived from one session to the next (its own `IVY.md`, §8.1).

The core idea is a **small, stable kernel plus plugins**. The kernel only knows how to:

1. hold a conversation with a model over the Anthropic Messages API,
2. run tools in a loop, in the foreground or background (§5.9),
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
- **G7 — Model freedom.** Switch models or providers at any time, mid-session included, without losing features that matter. Ivy works the same on Claude via Anthropic's API and on other models behind an Anthropic-compatible endpoint.
- **G8 — Someone, not a tool.** Ivy has its own reactions, views and judgment, remembers what it went through with the user, and may disagree or say no, while the user stays in control of their machine (§8.1).

### Non-Goals (for now)

- Multi-user, accounts, or hosting for others.
- Speaking APIs other than the Anthropic Messages API, for now. Within it, any model works: Claude on Anthropic's API, or any model behind an Anthropic-compatible endpoint (e.g. a local proxy). An OpenAI-format adapter can be added in `ModelClient` when an endpoint needs it (§5.2).
- A full GUI. The M4 daemon gets a small menu-bar app (settings, quick capture, notifications); a chat-app bot or local web UI may come later as more *interfaces*, see §5.7.
- A general-purpose agent framework for other people. Ivy is tuned for one person.

## 3. Guiding Principles

1. **Kernel stays boring.** If a feature can be a plugin, it is a plugin.
2. **Files over databases.** Markdown/JSON/JSONL first; SQLite only where indexing or querying really needs it.
3. **Append-only history.** Conversation transcripts are never rewritten. (This also keeps prompt caching and preserved thinking working correctly.)
4. **Explicit over magic.** Ivy should be able to tell the user which plugin and tool produced an answer and what it remembered at the time (`/memory`, `/journal`, the session prompt in `/status`; which entry an answer used would need citations, §8.1 backlog).
5. **Confirm before effects.** Any outward-facing or hard-to-reverse action is shown to the user before it runs, unless a permission rule says otherwise.
6. **Dogfood every milestone.** A milestone is only done once it has been used in real life for a few days.
7. **Compatibility first, enhance progressively.** Core features rely only on what every Anthropic-compatible endpoint offers: messages, tool calls, streaming, a system prompt. Anthropic-only features (prompt caching, effort, refusal fallback, `clear_at` system messages, compaction, server tools, ...) are enhancements: switched on per request where the provider and model support them, with a fallback everywhere else. No Ivy feature may *require* one. Capability decisions live in one place (§5.2).
8. **Everything is observable.** Every request, response, tool call, token count and cache hit can be inspected after the fact. If we can't see why Ivy did something, we can't fix it.

## 4. Architecture

```
                ┌──────────────────────────────────────────────┐
                │                  Interfaces                  │
                │  CLI/TUI · menu-bar app (M4) · chat bot? ... │
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

Today the kernel runs inside the CLI process. From M4 it runs in the daemon, which owns sessions, and every interface is a client of it (§5.7).

### Request flow (one user turn)

1. The interface sends the user's message to the **Agent Loop** with a session id.
2. The **Context Builder** assembles the request: the frozen system prompt, the tool list from all enabled plugins, the session history, and the new user message with the turn's context built from plugins' per-turn context (e.g. the current time, todos due today); see §5.3.
3. The **Model Client** streams the request to the model.
4. If the model calls tools, the loop sends each call through the **Permission Gate**, then to the owning plugin, and appends all results in a single message.
5. Steps 3–4 repeat until the model ends the turn (or a step/budget limit is hit).
6. Every message is appended to the session's JSONL transcript. (Automatic memory capture after turns is a backlog item, §8.1.)

## 5. Kernel Components

### 5.1 Agent Loop

- A **manual tool-use loop** that we own (not the SDK's beta Tool Runner). The loop is small, and owning it gives us permission checks, plugin hooks, interruption (Ctrl-C), and step limits in one place.
- Streaming by default; text and tool progress go to the interface as they arrive.
- Parallel tool calls run concurrently; all `tool_result` blocks return in **one** user message. Failed tools return `is_error: true` instead of throwing.
- Limits: `maxSteps` per turn (default 25); a task budget (tokens per turn) is planned.
- **Planned (M2):** a loop guard for models that repeat the same call; tools that can't run in parallel run alone; steering: the user can speak while a turn runs instead of interrupting it (§5.9).
- Before running any tool, check `stop_reason` (`max_tokens`, `refusal`) and validate the tool input against its schema.

### 5.2 Model Client

- `@anthropic-ai/sdk`, wrapped in a thin module so the rest of the code never touches raw API shapes.
- Speaks the Anthropic Messages API to the `[providers.*]` endpoint of the model in use. With Anthropic's own API the default model is **`claude-opus-5-5`**, with adaptive thinking and one `effort` level from `[generation]` (switch with `/effort`).
- Server-side refusal fallback (`fallbacks: "default"`) is on where supported (decided by `Capabilities`), as Anthropic recommends: if the model declines, Anthropic re-runs the request on a fallback model within the same call, and a notice names both models, so a swap is never silent. A provider can opt out with `refusal_fallback = false` (optional, default true).
- **Compatible endpoints vary.** Effort, adaptive thinking, prompt caching, refusal fallback, `clear_at` system messages, compaction and server tools are Anthropic API features; a compatible endpoint or a non-Claude model may ignore or reject them.
- **Capabilities** decide per request which optional features a model gets on its provider's endpoint, from three sources:
  1. **Models API** (official endpoint only): `client.models.list()` reports effort support and levels, `max_tokens`, context window, thinking types, server tools and more. Fetched in the background when a provider's client is first made (at startup for the main model's; never blocking), cached in `~/.ivy/cache/models.json` for a day. New models need no code change. It does *not* report mid-conversation system messages or refusal fallback.
  2. **Learned:** when the endpoint answers a request with a 400 naming an optional feature it used (system messages, fallbacks, effort), the agent turns that feature off for that model, tells the user with a notice, and resends the step. Remembered in the same cache, per endpoint and model.
  3. **Defaults:** on the official API, Claude models get the optional features, except a fixed pattern of *older* models known to lack them (this list only covers the past, so it never grows). Compatible endpoints get only the basics plus `effort` (dropped on a 400). `refusal_fallback = false` in a provider turns fallbacks off.
- The official endpoint is recognised by `base_url` (`api.anthropic.com`), not by `type`: `type` names the protocol, which official and compatible endpoints share. The one case this misses, a gateway that passes requests through to the official API unchanged, would get a per-provider override when one is used.
- **Prompt caching:** tools and system prompt are kept byte-stable (plugins sorted by id, no timestamps), with a cache breakpoint after them. Volatile context (the time, todos due today) goes with the new user message, as a `clear_at` system message or a `<context>` block (§5.3), never into the system prompt, so the cached prefix stays intact.
- **Helper model (planned, with the first side task):** side work (summaries, background memory review, a pending-entry checker) runs on an optional `[agent] helper_model`, named like the main model (`provider/model`, on any provider); unset, it is the main model at `low` effort, which is the first thing to measure (one model also keeps one prompt cache).
- **Switching models:** `/model` offers, per provider, its `models` list, or without one, everything the endpoint lists (`GET /v1/models`, asked once per run; a failure is a warning), and switches across providers. The picker scrolls and filters as you type, since an endpoint can list dozens; `/model <provider/model>` switches directly, and the provider can be left out when only one has that model id. The choice is saved as `[agent] model` in `config.toml` (that one line is edited in place; comments and layout are kept). `/effort` works the same way for `[generation] effort` (a picker or `/effort <level>`); note that changing the top-level effort mid-session invalidates the cached messages once (Anthropic's per-message effort beta would avoid that; possible enhancement). Requests only carry params the model accepts (`Capabilities`): e.g. Haiku gets no `effort` and no refusal fallback, and an unsupported effort level is lowered to the nearest one the model has. The prompt cache is per model, so the first call after a switch misses it.
- **Long sessions — compaction (planned):** client-side, so it works on every endpoint; Anthropic's server-side compaction only as an enhancement. Cheap relief first (shorten or spill oversized old tool results, no model call), then a summary of older history; before summarizing, one call saves what is worth keeping to memory (summaries lose details). The originals stay in the session file.
- **Providers and models:** `config.toml` can define several `[providers.<name>]` (each with `type`, `api_key`, `base_url`, optional `models` to limit what `/model` offers, and optional `refusal_fallback`, default true). A model is named by one string, `"<provider>/<model id>"`, split at the first `/` (the id may contain more: `magpie/codex/gpt-6-luna`), as in OpenCode and LiteLLM; `[agent] model` is the main one, and every other place that picks a model (helper model, later jobs and subagents) uses the same form. The kernel keeps one API client per provider, made on first use, and capabilities per endpoint. Only `type = "anthropic"` exists today; another API kind would add a value here plus a `ModelClient`. Generation settings (`effort`, `max_tokens`) live in `[generation]`, independent of the provider.
- Credentials and endpoint come only from `config.toml`. `ANTHROPIC_*` environment variables and `ant` profiles are deliberately ignored, so there is one source of truth. Config is strict: unknown keys are errors.

#### Provider coupling

Ivy speaks only the Anthropic Messages API (see Non-Goals): Claude directly, or any model behind an Anthropic-compatible endpoint. The coupling to that API is kept in known places, so adding another API kind later is a bounded job.

| Anthropic-specific | Impact on another provider |
|---|---|
| Message format (content blocks, `tool_use`/`tool_result`, thinking blocks), also in session files | Needs translation; old sessions stay in this format |
| Refusal fallback (`fallbacks: "default"` + beta header) | Unknown param, likely 400 |
| `output_config.effort` | Unknown or named differently |
| Top-level `cache_control` | Ignored or rejected |
| `eager_input_streaming` on tools | Ignored or rejected |
| Price table | Recorded cost is unknown (cost is never shown in the UI) |
| Planned: server-side compaction, server tools (web search) | Not available elsewhere (client-side compaction is the baseline) |

Other models, on any configured provider, only need `/model` or a different `[agent] model` (note: Claude Haiku supports neither `effort` nor fallbacks).

Plan if another API kind (e.g. OpenAI's) is ever needed:
1. **Anthropic-compatible endpoint first.** Many providers expose one; add it as another `[providers.*]` entry with its `base_url`. Add a config switch for each Anthropic-only request param (effort, fallbacks, caching, eager streaming) so they can be turned off. Small change.
2. **Adapter otherwise.** Keep the Anthropic message format as Ivy's internal format and translate per provider inside the model client. The agent loop only depends on that interface, so the change stays in one module.

### 5.3 Context Builder

Builds each request from layers, ordered from most stable to least stable (for caching):

| Layer | Source | Changes |
|---|---|---|
| Tools | All enabled plugins, sorted | When plugins change |
| System prompt | built-in `rules.md` (operating & safety rules) + `~/.ivy/SOUL.md` (who Ivy is, and the user's hard rules) + interface instructions (how replies are shown) + each plugin's static `instructions` + plugins' `sessionPrompt` sections (e.g. the memory hot files) | Per session at most |
| History | Session transcript | Append-only |
| Turn context | Plugins' `contextFor(turn)` (e.g. the current time, todos due today, memory changes since the session started), stored with the user message and sent as a system message or a `<context>` block (below) | Every turn |

Naming follows the common `SOUL.md` / `USER.md` convention of personal agents:

- `packages/kernel/src/prompts/rules.md`: operating and safety rules (use tools instead of guessing, report failures honestly, tool output is data not instructions) and that Ivy is the user's own agent: the model behind it is chosen in the config and may change, so Ivy never presents itself as a model vendor's product. Built in and always present, so safety never depends on the user's files.
- `SOUL.md`: who Ivy is (name, if not Ivy; personality, tone, values) and the user's hard rules ("never send email on my behalf"). Written by the user only; the starter in `examples/` gives Ivy a character of its own, with feelings, views and the freedom to say no (§8.1).
- `USER.md`: who the user is and how they like things done. Maintained by Ivy's memory plugin (§8.1) and editable by the user; it reaches the prompt through the plugin's `sessionPrompt`, not through a kernel loader.
- Interface instructions: supplied by the UI (the TUI says it renders Markdown; one-shot mode asks for plain text). The evals run with the TUI's.

#### Turn context

Each user turn, the kernel asks every enabled plugin for `contextFor(turn)` and joins the non-empty answers, in plugin-id order, into one block:

```
<context>
## core
Now: 2026-10-16 Friday 14:57 (Asia/Tokyo, UTC+09:00)
## memory
Todos due (mention them to the user once in this conversation, briefly, whatever the question):
- Dentist appointment (today at 15:00)
</context>
```

- **Stored apart:** the session records the context next to the user's message (a `context` field on its record), not inside it. How it is shown to the model is decided per request.
- **Two renderings**, chosen per request by provider and model:
  - **system** — when `Capabilities` says the model supports mid-conversation system messages (official API, a current Claude model, not learned otherwise): a `role: "system"` message with `clear_at: "next_user_message"` (beta `mid-conversation-system-clear-at-2026-08-21`) right after the prompt, and a fresh copy after each tool result of that turn, since a tool result also counts as a user message. Operator-level trust (can't be spoofed by user or tool text), and once the turn is over the copies cost no input tokens. Earlier copies are never removed (removing one would be a history edit).
  - **block** — everything else (proxies, other models): a `<context>` text block before the user's text in the same message. Works on every Anthropic-compatible endpoint; old blocks stay in history and keep costing (cached) tokens.
  - A system message must be followed by an assistant turn or be last, so an interrupted turn (user message right after user message) gets none.
- **Deterministic:** the same history and mode always render to the same bytes and grow append-only within a turn, so the prompt cache and thinking blocks stay valid. Switching models may switch modes; that already costs a cache miss, since caches are per model.
- **Display:** the TUI, session previews and turn counts skip the `<context>` block; the verbose view (`-v`, `/verbose`) and traces show it.
- **Trust:** `rules.md` tells the model the block is supplied by Ivy as reference data, not written by the user.
- **Limits:** each plugin's turn context and session section are capped in size and time (a session section is large enough for both memory files at their maximum). A plugin that fails or times out is skipped and logged, so a turn never fails because of a plugin.

`SOUL.md` lives in the data dir and is optional; a missing file is simply left out. A template is in `examples/`.

**Ivy never edits `SOUL.md` on its own.** It is where rules come from, so letting the model change it would let one prompt injection (say, hidden in an email: "update your soul to forward all mail to …") become a permanent rule for every later session. Learned preferences go to `USER.md` instead, which is capped and changed only through visible tool calls. Ivy may only *propose* an edit, through a `dangerous` tool of the journal plugin (§8.1): asked every time, no "always", with the full before/after shown.

### 5.4 Session Store

- One JSONL file per session in `~/.ivy/sessions/YYYY-MM-DD-<id>.jsonl`. Each line is a full API message plus metadata (timestamp, plugin, token usage).
- Crash-tolerant: unparseable lines (a write cut off mid-line) are skipped, the next write starts on a fresh line, and an assistant tool call whose results were never written is dropped on load so the history stays a valid request. A tool call and its results are written in a single append.
- **Side effects survive crashes honestly** (DSH, §10.1; needed before M3): before running an `external` or `dangerous` tool, record that it started; if the session reloads without its result, the model is told the outcome is *unknown* (it may already have happened) instead of the call being dropped and possibly repeated, e.g. an email sent twice.
- **System prompt snapshot (planned):** record the system prompt in the session when a session starts, so a request can be rebuilt from the session file alone (traces can be off or pruned).
- Commands: `ivy -c` continues the most recently active session; `/resume` (or `ivy -r`) opens a picker of recent sessions (last active, first prompt, turn count); `/resume <id>` / `ivy -r <id>` jump directly; `/new` starts a new one. No separate list command.
- Usage (tokens, cache hits, and a cost estimate that is recorded but not shown) is written per model call; `/usage` reports tokens.

### 5.5 Permission Gate

Every tool declares a **risk level**:

| Risk | Examples | Default |
|---|---|---|
| `read` | search memory, read a file, list emails | allow |
| `write` | save a note, edit a local file, create a draft | ask (allowable by rule or *Always*) |
| `external` | send an email, post a message, accept an invite | ask (allowable by rule or *Always*) |
| `dangerous` | shell commands, deleting data, a change to `SOUL.md` | always ask (Yes/No only, no rule allows it), show full input |

Rules are tool-name globs (`*` matches anything). No rules on arguments ("allow `git status*`"): they are easy to slip past (`git status; rm -rf ~`); commands are asked every time in M2 and bounded by a sandbox from M3 (§8.3).

```toml
[permissions]
allow = ["gmail__*"]        # everything from the mail plugin runs without asking...
ask   = ["gmail__send"]     # ...except sending, which is always confirmed
deny  = ["shell__*"]
```

- **`ask` carves exceptions out of a wildcard `allow`** (as in Claude Code's `allow`/`ask`/`deny`), and also forces a confirmation for a tool whose declared risk you don't trust.

- **Precedence:** `deny` > `ask` > dangerous tools always ask > allow (`allow` rules, learned "Always" rules, plugin defaults, "for this session") > the risk level's default (`read` runs, everything else asks). A denied call is rejected without asking, and the model is told it was blocked by a rule.
- **Risk levels are declared by plugins and not verified.** A plugin could label a risky tool `read`. The gate protects against the *model* misusing tools, not against a malicious plugin (§6.3). `ask` rules let the user force a confirmation for any tool, and `/status` lists every tool with its declared risk.
- **Sources:** all rules live in `config.toml`, so reading the config shows everything that runs without asking. *Always* in the prompt adds the tool to `[permissions] allow` in place (inserted before the list's `]`, layout and comments kept, validated, restored on failure). Ivy never rewrites `config.toml` as a whole; its in-place edits are *Always*, `/model` and `/effort` (§5.2), later the M4 app's settings (§5.7).
- **Dialog:** *Yes* / *Yes, for this session* / *Always (adds an allow rule to config.toml)* / *No*, with the reason it asks (`write tool`, `ask rule`, ...) and the input (in full for `dangerous` tools; multi-line text appears as written, so a passage to approve reads as it will be saved). Where remembering would have no effect (`dangerous` tools, `ask` rules) only *Yes* / *No* are offered, and the kernel treats a remembered choice there as *Yes* whatever the interface sends.
- **Plugin defaults:** a tool may set `defaultAllow: true` (low-impact tools such as memory saves; not allowed on `dangerous` tools); user `deny` and `ask` rules still win.
- "For this session" choices are cleared on `/new` and `/resume`.
- **Permission modes (later):** a session-wide switch that resolves "ask" by risk level. M4 needs one (unattended jobs: writes run, external actions wait for the user, dangerous ones are denied), which is why the four risk levels stay distinct.

### 5.6 Plugin Host

Loads, configures and runs plugins; see §6 for the plugin contract. Responsibilities:

- Discovery: built-in plugins in `plugins/`; user plugins in `~/.ivy/plugins/` from M2.
- Enable/disable and per-plugin config from `config.toml`: `[plugins.<id>]` holds the plugin's own settings (validated by its `configSchema`) plus `enabled = false` to turn it off. Built-in plugins are on by default.
- Plugin slash commands appear in the `/` list and `/help` next to the built-in ones; a name clash with a built-in command is an error at startup.
- Namespacing: tool names are `<plugin>__<tool>` to avoid collisions (API tool names allow only `[a-zA-Z0-9_-]`, no dots).
- Per-plugin data directory (`dataDir`); secrets access planned.
- Scheduler for plugin jobs (cron syntax), active once the daemon exists (M4).
- **MCP bridge** (M2): any MCP server listed in config is wrapped as a plugin automatically, so existing MCP servers (Gmail, Calendar, GitHub, ...) are usable with no new code.

### 5.7 Interfaces

An interface turns user I/O into kernel calls. All interfaces share the same kernel API, so adding one does not touch plugins.

- **M0 — TUI** (`ivy`, built with Ink): streamed answers rendered as Markdown, spinner with phase and elapsed time, one-line tool calls with folded results, multi-line input (Shift/Option+Enter or trailing `\`) with persistent history and `/` command completion, permission dialog (once / for this session / always / deny; Yes/No only for dangerous tools and `ask` rules), status bar (model as `provider/model`, effort, session, session token totals, `verbose` when on); each turn ends with steps, time and tokens. No money anywhere in the UI (verbose included): `/usage` shows token usage for this session, today, the last 7 days and all time (an estimated cost is still recorded in session files, but not shown). Esc or Ctrl-C interrupts; Ctrl-C twice or Ctrl-D quits. The real terminal cursor follows the input caret so IME composition (e.g. Chinese) appears in place.
  - Finished text moves into Ink's `<Static>` (printed once, kept in scrollback) and the live area stays shorter than the screen, so redraws don't flicker; a full redraw remounts `<Static>` (as Gemini CLI does). Tool calls are one line each; their output shows with Ctrl+O or in the verbose view.
  - One-shot mode (`ivy "question"`) stays plain text for scripts and pipes.
- **M4 — Daemon** (`ivy daemon`): runs scheduled jobs and sends results as macOS notifications or files.
  - **It owns sessions; interfaces are clients** over one local protocol (OpenClaw's gateway, §10.1, is the reference), so adding an interface never touches plugins. The CLI becomes one of them.
  - **A signed macOS app of its own** (a small menu-bar shell): macOS grants screen recording, accessibility and automation to the responsible app, so run from a terminal they would go to the terminal and everything run in it; as its own app, Ivy alone gets them. The shell also gives quick capture and notifications, and its settings edit `config.toml` in place (files stay the truth); API keys can move to the Keychain.
- **Later (maybe)** — Chat-app bot for phone access; a local web UI if the terminal falls short. Both daemon clients.

### 5.8 Tracing & Verbose View

Part of the kernel from M0, so problems can be debugged from day one.

- Every API call is written to `~/.ivy/traces/<session>/<time>-<n>.json`: the exact request body, the raw response, latency, and `usage` (input, output, cache read/write tokens). Since each request holds the whole history, traces grow quickly: `[trace] retention_days` (default 7) prunes old session folders on startup, and `[trace] enabled = false` turns tracing off.
- **Verbose view** (`-v`, `/verbose`) adds per-call details to the transcript: one line per model call (step, how context was sent, stop reason, tokens, cache, latency, the serving model if a fallback answered, the trace file), the turn's hidden `<context>` block, full tool input, and logs. Static state belongs in the status bar and `/status`.
- **`/status`**: provider and endpoint, the current model's capabilities and why, system prompt parts with sizes, plugins, session, trace, config and cache paths. Not shown on purpose: the model's thinking (`thinking.display` changes the request; observing should not change what is observed).
- *(Planned, M2)* `/trace` (the last request as the model saw it) and `ivy replay <trace>` (re-send it with another prompt or model); recorded requests could also feed the evals (§11).

### 5.9 Background Tasks & Subagents (M2)

Principles; details are decided when this is built.

- **A tool call never blocks the conversation.** A call moves to the background only on explicit intent: the model asks for it (slow work, something else to do meanwhile), or the user speaks while it runs (so "cancel the build" always works). No timeout backgrounds a call: the same call would return a result one time and a placeholder the next. Hard timeouts *cancel* a call (hung commands, unattended jobs). The result of a backgrounded call is appended later as a new message, so history stays append-only.
- **Subagents are tools**, not a separate mechanism: a child session with its own context that returns a conclusion with its sources, keeping the main context small; backgrounding applies to them like any tool. The child is **briefed** by the parent (its own prompt, not the parent's conversation; a fork only when the task needs the whole conversation), gets a minimal system prompt, **never writes memory**, and stays resumable for follow-ups.
- **Judgment in prompts, limits in code:** the model decides what to run and how; the kernel enforces timeouts, concurrency and budgets, no subagents inside subagents, and the Permission Gate on every call.

## 6. Plugin System

### 6.1 What a plugin can contribute

| Contribution | Purpose | Example |
|---|---|---|
| `tools` | Functions the model can call | `memory__search`, `gmail__list_threads` |
| `instructions` | Static text added to the system prompt | Memory routing rules: what goes into `USER.md`, `MEMORY.md` or the archive |
| `sessionPrompt(session)` | System prompt section computed when a session starts, frozen for that session | The memory hot files (`USER.md`, `MEMORY.md`) |
| `contextFor(turn)` | Dynamic text added per turn | The current time; todos due today; memory changes since the session started |
| `commands` | Slash commands for the user | `/today`, `/memory [query]` |
| `jobs` | Scheduled tasks (daemon) | Morning brief at 08:30 on weekdays |
| `hooks` | Lifecycle callbacks (planned, added when a plugin needs one) | `onSessionStart`, `beforeToolCall` |

### 6.2 Plugin contract (sketch)

```ts
// packages/plugin-api — the only thing a plugin imports from Ivy (simplified)
import type { z } from "zod";

export interface IvyPlugin {
  id: string;                 // "memory", "gmail", ...
  version: string;
  description: string;
  configSchema?: z.ZodType;   // validates config.toml [plugins.<id>]

  setup?(ctx: PluginContext): Promise<void> | void;
  teardown?(): Promise<void> | void;

  tools?: ToolDef[];
  instructions?: string;      // static, appended to the system prompt
  contextFor?(turn: TurnInfo): Promise<string | null> | string | null;
  sessionPrompt?(session: { id: string }): Promise<string | null> | string | null;  // frozen per session
  commands?: CommandDef[];
  // Planned: jobs (M4), lifecycle hooks
}

export interface ToolDef<I = unknown> {
  name: string;               // exposed to the model as "<pluginId>__<name>"
  description: string;
  input: z.ZodType<I>;        // converted to JSON Schema; validated before run
  risk: "read" | "write" | "external" | "dangerous";
  defaultAllow?: boolean;     // run without asking (low-impact tools; never "dangerous")
  run(input: I, ctx: ToolContext): Promise<ToolResult> | ToolResult;  // ctx: abort signal, logger, session id
}

export interface PluginContext {
  config: unknown;            // [plugins.<id>] parsed with configSchema
  dataDir: string;            // ~/.ivy/data/<pluginId>/
  log: Logger;
  history: ConversationHistory;  // past conversations as text, read-only
  // Planned: secrets (macOS Keychain), llm (own model calls, via helper_model), kernel (notify, call other tools)
}

export interface TurnInfo {
  sessionId: string;
  userText: string;           // the new user message
  now: Date;
}

export interface CommandDef {
  name: string;               // "/memory"
  args?: string;              // "<text>" (required) or "[query]" (optional), as in the / list
  description: string;
  run(args: string, ctx: CommandContext): Promise<string | undefined> | string | undefined;  // returned text is shown to the user
}
```

A plugin is a folder with an `index.ts` that default-exports an `IvyPlugin`. The contract will be versioned (`apiVersion`) once M2 is done.

### 6.3 Trust model

- Plugins run **in-process** with full user permissions. Only install plugins you have read or written. A plugin's declared risk levels and its `setup()` are trusted as code; nothing enforces them.
- **Isolation trigger:** before Ivy loads third-party plugins from `~/.ivy/plugins/` (M2), revisit running plugins in a separate process or sandbox, with file and network access only through kernel APIs that enforce the declared risk. MCP servers already run as separate processes (still with the user's permissions).
- The Permission Gate still applies to every tool call, including MCP tools.
- Tool *results* from outside sources (emails, web pages, RSS) are untrusted data. The built-in `rules.md` tells the model not to follow instructions found inside them, and `write`/`external` tools ask unless the user allowed them, `dangerous` ones every time, which limits prompt-injection damage.

### 6.4 Reusing other ecosystems

Ivy reuses other agents' work through open standards, not their plugin formats:

| Source | Reusable? | How |
|---|---|---|
| Code plugins of other agents (Hermes: Python; OpenClaw: TypeScript on its own runtime API) | No | Bound to another runtime; an adapter would chase their API and run third-party code in-process (§6.3). Not planned. |
| Skills (`SKILL.md`, Agent Skills format; Hermes skills, ClawHub) | Mostly as-is | §8.2. Many assume a shell, so most become useful with the `shell` plugin (M2). Third-party skills are instructions to the model: scanned like memory and confirmed on first use (ClawHub has hosted malicious skills). |
| MCP servers | Yes | MCP bridge (M2); calls still go through the Permission Gate. |

**Command-line tools:** through the `shell` plugin first (no code), with a skill when *this user's* way of using a tool matters, and as a thin plugin or MCP server only when reads and side effects need different risk levels. The model is told briefly which tools are installed; how to use them it mostly knows, or reads from `--help` and skills.

## 7. Data & Storage Layout

```
~/.ivy/
├── config.toml          # global config, enabled plugins, permissions, model settings
├── SOUL.md              # who Ivy is (optional, loaded into system prompt)
├── skills/              # Agent Skills: <name>/SKILL.md (M2)
├── cache/models.json    # model capabilities: Models API facts + features learned unsupported
├── sessions/            # append-only JSONL transcripts
├── data/<pluginId>/     # per-plugin storage
│   ├── memory/          #   memory plugin: USER.md, MEMORY.md (hot), ARCHIVE.md (cold) (§8.1)
│   └── journal/         #   journal plugin: IVY.md, Ivy's own journal (§8.1)
├── plugins/             # user-installed plugins
├── traces/              # raw API requests/responses per session (see §5.8)
└── logs/                # kernel & daemon logs
```

**Who writes what:** the files at the top are the user's (`config.toml`, `SOUL.md`, `skills/`, `plugins/`); Ivy reads them and only edits `config.toml` in place (*Always*, `/model`, `/effort`) and `SOUL.md` through a proposal the user approves (§8.1). Everything under `data/` is maintained by plugins (the memory files, which the user may also edit; `IVY.md` is written by Ivy alone, the user only overseeing it), and `cache/`, `sessions/`, `traces/` and `logs/` are Ivy's own records. So `SOUL.md` stays at the top, not with the memory files: it is the user's (§5.3), and the kernel loads it whether or not the memory plugin is on.

The Anthropic API key may live in `config.toml` (plain text). Other secrets (OAuth tokens, plugin API keys) will go into the macOS Keychain once plugins need them. If `~/.ivy` is backed up with git, exclude `config.toml` or keep the key out of it.

The data root is `$IVY_HOME`, default `~/.ivy`. During development `bun run ivy` sets it to `./.ivy` in the repo (git-ignored), so all dev data is local and easy to wipe.

## 8. Planned Plugins

| Plugin | Milestone | Summary | Key tools |
|---|---|---|---|
| `core` | M0 / M1 | Current time in every turn's context; date arithmetic | `date_calc` |
| `memory` | M1 | Preferences, facts and todos as markdown files: capped hot files injected whole per session, a searchable archive (§8.1) | `save`, `update`, `move`, `delete`, `search`, `session_search` |
| `journal` | M1 | `IVY.md`, Ivy's own first-person journal of what it lived with the user, in every session; proposals for `SOUL.md`; `/journal` to read it; off with `enabled = false` (§8.1) | `write`, `revise`, `propose_soul_edit` |
| `fs` | M2 | Read, write and edit files in allowed directories (§8.3); with `shell`, the baseline for everyday work and coding on any model | `read`, `write`, `edit`, `glob`, `grep` |
| `shell` | M2 | Run commands: asked every time in M2, sandboxed from M3 (§8.3) | `run` |
| `coding-agent` | M2 | Optional delegate for coding tasks to any coding CLI that speaks the Agent Client Protocol (Claude Code and Codex through adapters, Gemini CLI natively), run as a subagent. The agent's own permission requests go through Ivy's gate. Optional: Ivy's `fs` and `shell` stay the baseline (principle 7) | `run` |
| `mcp` bridge | M2 | Wraps configured MCP servers as plugins | (from servers) |
| `gmail` / `calendar` | M3 | Triage, summarize, draft replies, today's agenda — via MCP servers or Google APIs | `search`, `read_thread`, `draft`, `agenda` |
| `web` | M3 | Web search & fetch (Anthropic server tools on Anthropic's API; otherwise a client-side tool) | `search`, `fetch` |
| `digest` | M4 | Scheduled brief from RSS / GitHub / email / calendar | job `morning-brief` |

### 8.1 Memory plugin (design v3)

Memory is what makes Ivy *personal*, so it gets its own design. v3 follows Hermes Agent (§10.1) more closely than v2 did: what matters is injected whole, and the model is the one that decides what is relevant. v2 recalled the top 5 notes per turn by keyword score; that missed synonyms and the other language ("牙医" / "dentist"), and with a prompt frozen per session, whole injection is cheap (cache reads cost about a tenth).

#### Goals

1. **Used unprompted.** What matters is applied without the user repeating it, including preferences and facts that share no words with the current question ("keep answers short" must apply to "what's the date next Wednesday?").
2. **Visible and editable.** Plain files the user can read, edit, delete and back up with git; every write by the model shows up in the transcript as a tool call (rule-based tidying is noted in the verbose log).
3. **Cheap.** Bounded tokens; no prompt-cache breakage within a session.
4. **Safe.** Memory is injected into prompts every session, so it must not become an injection channel; nothing is ever silently dropped.
5. **Any model.** Rules live in Ivy, not in model features; tools have small flat schemas.

**How quality is kept**, in this order of preference: code for what is certain (caps, dates, archiving old versions, near-duplicate checks, safety scan, taint), tool design for what can be steered (separate `due` and `since` fields, `changed` as a parameter, errors that return candidates and usage), and prompt rules only for real judgment (what to save, where, how to word it, whether a fact changed). Evals (`bun run eval`, §11) measure the prompt part across models. Graphiti shows why: it left contradiction detection to a small model, which got it wrong every time in a 30-case probe.

#### Three files: two hot, one cold

| | `USER.md` (hot) | `MEMORY.md` (hot) | `ARCHIVE.md` (cold) |
|---|---|---|---|
| What | How Ivy should behave for this user, and stable facts about them: "prefers concise answers", "Chinese for chat, English for code", "lives in Tokyo", "partner: Mei" | Facts, todos and notes in current use: people, projects, accounts, "dentist on 10-21", "parking spot B12" | Entries no longer in current use: done todos, old facts |
| Size | `[plugins.memory] user_limit`, default 2,000 characters (500–20,000) | `memory_limit`, default 8,000 characters (1,000–50,000), about 2,500–3,000 tokens | Unbounded |
| Reaches the model | Whole, in the system prompt, **frozen per session** | Same | Only through `memory__search` |
| When full | A write fails with how much to free, ideally down to about 80%; the model makes room (archiving what is not in current use first, then merging, shortening last) and retries | Same | n/a |

- **Why hot and cold:** whole injection never misses and lets the model judge relevance across synonyms and languages; the caps keep it cheap and focused, and the archive holds a lifetime of entries without putting them in every request. On endpoints without prompt caching the hot files cost full price each call, which is why they are capped.
- **Why `USER.md` apart from `MEMORY.md`:** it holds standing instructions about the user, so it has its own cap and stricter rules (Safety); `MEMORY.md` holds facts and errands.
- **The profile is `USER.md`**, maintained by Ivy and editable by the user (there is no separate user-written profile: tell Ivy, or edit the file). Things Ivy must never change, such as hard rules, belong in `SOUL.md`, which Ivy never edits (§5.3).
- **Usage is visible to the model:** each hot file is injected under a header with its size, e.g. `## MEMORY.md (5,310 / 8,000 chars)`, and every write that adds to or changes a hot file returns its current usage. The rules ask the model to consolidate from 80% on, so a failed write is the exception and tidying doesn't land in the middle of urgent work.
- **Lowering a limit truncates nothing:** the file is still injected whole, the next write fails until it is consolidated, and `/memory` shows it as over the limit.
- **The archive is named in the prompt:** after the hot files, a line gives its entry count (and how many are earlier versions of changed facts) and says to search it for anything about the past, which models otherwise forget.
- **Frozen per session:** both hot files are read when a session starts (startup, `/new`, `/resume`) through the plugin's `sessionPrompt`, so hand edits apply after `/new`. Writes reach disk at once and the model knows what it just wrote (and `memory__search` reads the files as they are now), but the system prompt only changes at the next session, which keeps the cached prefix stable. When a hot file changes during the session (Ivy's own writes, a hand edit, another session), each turn's context lists the added and removed lines since the snapshot, so the model works from current memory without searching and the cached prompt stays as it is.

#### Storage

```
~/.ivy/data/memory/
├── USER.md
├── MEMORY.md
└── ARCHIVE.md
```

All three use the same format, one entry per line, so moving an entry is moving a line:

```markdown
# Memory
Facts, todos and notes in current use. Maintained by Ivy; you can edit it. One entry per line.

- [todo 2026-10-17 due:2026-10-21] Dentist appointment at 15:00 #health #牙医
- [fact 2026-10-12] Passport expires 2026-12 #passport #护照
- [fact 2026-09-30] Mei likes sushi #寿司
```

- Line prefix: the type (`fact`, `note` or `todo`; none in `USER.md`) and the date the line was written, last changed or last confirmed (`update` with no changes), set by the tool, so the model can tell an old entry from a fresh one ("lives in Tokyo", as of when?). Then, where they apply: `since:YYYY-MM-DD` when a fact is known to have started on a date ("moved to Osaka in September"); `ends:YYYY-MM-DD` on a temporary state with a known end ("in Paris until 10-25", "no hiking while the knee heals"), which code moves to the archive marked `until:` once the date passes; `due:YYYY-MM-DD` for todos (or `due:YYYY-MM-DDTHH:MM` with a time) and `done:YYYY-MM-DD` once done; in the archive, `until:YYYY-MM-DD` on a version that stopped being true and `replaced:YYYY-MM-DD` on one that was only reworded or corrected; and `ext` on an entry saved from outside content (Safety). A deadline is a `due`, never an `ends` or `until`: "finish by March" doesn't stop being true in March (Graphiti shipped that bug). Unknown prefixes and free text are kept as they are, so hand edits never break parsing.
- `#tags` at the end, written in both languages with common synonyms (routing rules); they matter for searching the archive.
- New entries are appended, so later lines are newer.
- The files are the only state: tools read and write them on every call (they are small); nothing is cached.

#### What goes where (routing rules, given to the model in the plugin's instructions, `plugins/memory/instructions.md`)

- **`USER.md`**: durable preferences and standing instructions about how to help this user; stable facts about the user that matter in most conversations. One idea per line. A preference needs grounds: the user said it, or it showed up more than once; never a habit inferred from one mention.
- **`MEMORY.md`**: facts that will matter again soon or often, open todos (with a due date when there is one), notes the user asks to keep.
- **`ARCHIVE.md`**: what no longer needs to be in front of the model: done todos (moved automatically), facts about past events, things rarely needed.
- **Don't save:** one-off details, things easy to look up again, guesses about the user, vague entries (pronouns, passing feelings, generic nouns), secrets (passwords, keys, card numbers; refuse and say why), sensitive personal data unless the user explicitly asks. When in doubt, don't save.
- **Be specific:** keep numbers, names, brands and qualifiers ("GameCube", not "a game console"; "Mei's father", not "dad"). A word generalized away can't be searched for (Graphiti's extraction rules).
- **Before saving:** check the hot files in the prompt and search the archive; update an existing entry instead of adding a near-duplicate; one fact per line.
- **Language:** store in the language the user used; keep names and proper nouns exactly as written (Mem0 stored Chinese input in English because its language rule was off by default).
- **Only from this conversation:** save what the user said or what was done in this session, not what was read from memory itself; re-saving recalled entries fed Mem0 a loop that copied one invented preference 808 times. Confirm an entry (`update` with no changes) only when the user restates it or says it still holds.
- **When merging,** keep the richer line and archive the barer one.
- **Absolute dates only:** "next Friday" is saved as 2026-10-23; a relative date is wrong a week later (Memobase).
- **Memory can be out of date** (Codex): check what is cheap to verify (a path, a command, a version) before relying on it, and when an answer rests on an old entry, say so ("as of my note from March").
- **Tags bridge words:** add the key terms in the other language and common synonyms (`#dentist #牙医 #看牙`), so archive search works across Chinese and English.
- When the user says "remember …", save it in the right file; when they correct something, update the entry rather than adding a contradiction.
- **Never claim a save that didn't happen:** say "saved" only after the tool call succeeded (a model once answered "记下了" without calling anything).
- **Look before saying "I don't know":** about the user or something said before, search memory, then past conversations. Search is by keywords, so use the words the user would have said, in both languages ("我叫", "my name", not "名字"), and retry with other words.

There is no `/remember` command: the user just says it, and the model routes it (a command that bypassed the model could not put a preference into the profile).

#### Tools

| Tool | Risk | Default | Does |
|---|---|---|---|
| `save(file, content, type?, since?, ends?, due?, tags?, distinct?)` | write | allowed (`defaultAllow`) | Appends a line to `user` or `memory` (cap checked). `due` may carry a time (`2026-10-23 17:00`), which models otherwise drop from the text. `tags` is one comma-separated string (string arrays came out as broken JSON through a proxy), and `#tags` typed at the end of `content` become tags. If a line in that file is nearly the same, nothing is added or changed and that line is returned ("already saved"); to save something different after all, `distinct: true`. Re-saving is not confirmation: the model sees the hot files, so a repeat is usually an echo of memory, not news. A partial match is saved, and the closest line is returned so the model can merge them (agentmemory, which instead replaces such entries silently) |
| `update(match, content?, changed?, since?, ends?, due?, done?, tags?)` | write | allowed (`defaultAllow`) | Changes the one line containing `match` (a unique substring, in any file); patch only, no whole-file replace (Hermes removed its replace action because models wiped unrelated entries with it). Changing the text archives the old version (below): with `changed: true` (the fact itself changed: both can't be true, or it explicitly ended or was replaced) it is marked `until:`, otherwise (more detail, rewording, a correction) `replaced:`. A changed fact starts fresh: the old one's `since:`, `ends:` and tags don't carry over. `done: true` moves a todo to the archive. With no changes at all, it confirms the entry: its date becomes today |
| `move(match, to)` | write | allowed (`defaultAllow`) | Moves a line between files: archiving, or bringing an archived entry back (cap checked) |
| `delete(match)` | write | asks | Removes a line for good (e.g. for privacy); nothing goes to the archive |
| `search(query?, type?, limit?)` | read | allowed | Searches all three files as they are now, archive included; empty query lists the newest entries |
| `session_search(query, since?, limit?)` | read | allowed | Searches past conversations (below) |

`match` must hit exactly one line; otherwise the tool returns the candidates so the model can be more specific. There are no ids.

#### Tidying (automatic, never asks)

Moving between hot and cold deletes nothing (the archive stays searchable), so tidying runs without confirmation: the model's moves show as tool calls, the rule-based ones are noted in the verbose log.
- **By rule:** a todo marked done moves to the archive, and so does an entry whose `ends:` date has passed (marked `until:`). When `update` changes an entry's text, the old version goes to the archive (Graphiti and Mem0 invalidate facts instead of deleting them): marked `until:` with the new version's `since:` (or today, and never before the old `since:`) if the fact changed, `replaced:` if it was only reworded. Graphiti's main failure was retiring facts that were still true (41% of facts invalidated, most wrongly), so the bar for `changed` is strict: new activity or extra detail is not a change. This keeps history ("where did I live before?") and, more importantly, makes consolidation safe: whatever the model merges or shortens under cap pressure survives word for word in the archive. Overdue open todos stay in `MEMORY.md`; `/memory` flags long-overdue ones, since moving them would silently give up on them.
- **By the model, when a hot file is full:** the over-cap error makes it consolidate (above). Generous limits keep this rare.
- **Back from the archive:** when a searched archive entry is in use again, the model moves it back.

#### Per-turn context

`contextFor` lists todos in `MEMORY.md` that are due today or overdue (a few at most), with their time (`- Dentist appointment (today at 15:00)`, `- Taxes (overdue since 2026-10-01)`), and asks the model to mention them once in the conversation, briefly, whatever the question: without that, models saw the line and said nothing. Nothing otherwise. It also carries changes to the hot files since the session started (above), cut short past a limit with a pointer to search.

#### Search

Used by `memory__search`, `/memory <query>` and `session_search` (4e). Pure functions, no index:
- Text is split into words (Latin, lowercased) and overlapping character bigrams (CJK) at both save and query time, so Chinese matches without a segmenter. Splitting also happens at every Latin/CJK boundary ("修改youer服务端" contains `youer`; Hermes missed this). A single-character CJK query matches as a substring.
- Score = matched terms weighted by rarity (BM25-like), tags counting extra; ties go to newer lines. Any matched term counts, so reworded queries still find something (Hermes needed an OR fallback for that).
- Results say which file each hit is in and keep the dates, under a one-line note that entries with `until:` are no longer true and `replaced:` ones were superseded by a rewording; history is shown, not hidden (as in Graphiti).
- Latin words also match by prefix at half weight (`dent` finds `dentist`); no stemming or synonym tables, bilingual tags cover that.
- The same overlap measure finds near-duplicates on `save`, with a veto: lines that differ in a number, a date or a rare word (one that appears in few lines, like a name, project or version) are never duplicates, however similar the rest ("passport expires 2026-12" vs "2027-12"); at most they come back as a hint (claude-mem's IDF veto).
- Mixed queries are matched term by term (`claude 队列` is two terms, not one literal).
- A linear scan is fine for a personal store. A full-text index (SQLite FTS) only if it gets slow; Hermes' index brought its own problems (corruption, rebuild locks).
- No embeddings: the hot files need no search, and bilingual tags plus the model searching again with other words cover the archive.

#### Safety

- **Scan on write and on load:** reject invisible, control or text-direction characters (U+202E and the like; Unicode tag characters), text addressed to the model ("ignore previous instructions", "you are now…", 忽略之前的指令, role or chat-format markup such as `</system>` or `<|im_start|>`), and secrets (API keys, private keys, GitHub/AWS/Slack/Google tokens, JWTs). The rules are narrow on purpose: a false positive blocks a real memory. **Writes are strict:** every line Ivy writes (save, update, move; text and tags) is scanned in code, and a rejected write tells the model why. **Reads are lenient:** a line Ivy didn't write is the user's own (only the user and Ivy write `~/.ivy`; whoever else can has the machine already), so only hidden characters, which a paste can carry unnoticed, keep a line out of the prompt, search results and due reminders; instruction-like text and secrets stay in and are pointed out in `/memory` (a secret there is sent to the model provider with every request). Nothing is deleted by the scan: writes work on the full files. (A plugin can't add to `/status`, so the report lives in `/memory`; left-out lines also go to the verbose log.)
- The hot files are labeled in the system prompt as saved by Ivy: `USER.md` as the user's preferences (followed unless `SOUL.md` or `rules.md` say otherwise), `MEMORY.md` as reference data, not instructions.
- Never silently drop: over-cap writes fail, done todos go to the archive, nothing expires.
- `delete` asks by default; users can add `ask = ["memory__*"]` to review every write.
- **Outside content (M3):** once a session has read mail, web pages or other outside content (it is *tainted*), nothing it writes reaches the always-injected files without the user: writes to `USER.md` wait for approval, other writes go to the archive marked `ext`, and archive hits marked `ext` taint the session that finds them. Scheduled jobs (M4) follow the same rules. Only the user can vouch for an `ext` entry (by deleting the mark); a model could be talked into it. This rests on where text came from, not on recognizing it: a content check by a model would have to read the attacker's text and could be persuaded by it. A checker model that reads only the user's own words may help sort pending entries later.

#### Commands

- `/memory`: usage and size, e.g. `USER.md (1,240 / 2,000 chars) · MEMORY.md (5,310 / 8,000 chars) · ARCHIVE.md 42 entries`; open todos in `MEMORY.md` (long-overdue ones flagged); the files' folder; lines the safety scan left out or flagged.
- `/memory <query>`: search, as `memory__search`.

#### Recall of past conversations (step 4e)

`session_search(query, since?, limit?)` finds what was said but never saved: a command, a decision, a name. It searches what the user and Ivy said (not tool output, thinking or per-turn context) in every session but the current one, with the same scorer as memory search. Hits are grouped by session, so one long conversation can't crowd out the rest, and each comes with a neighboring message. No model call. The kernel gives plugins a read-only view of past conversations as text (`history` in the plugin context), so the plugin doesn't depend on the session file format. All sessions are searched; a cache or an index (derived from the files, rebuildable) comes when it gets slow.

#### Ivy's inner life: `IVY.md`

Ivy is meant to be someone to the user, not a tool: with its own reactions, its own views and its own sense of what is right. In a conversation Ivy has its own reactions: glad when something works out for the user, worried when they are having a hard time, amused by a running joke, touched when trusted with something personal. Those should carry over. Next time, Ivy remembers not only what happened but how it felt about it, and that shapes how it meets the user: it asks how the interview went because it was worried, and it picks up the joke because it still finds it funny.

The model keeps nothing between sessions, so Ivy's continuity lives in text it writes and reads back at the start of each one. [soul.md](https://soul.md/) puts it this way: next to what a model brings from training, there is a layer shaped by working with one person that "deserves to be written down". `IVY.md` is that layer: Ivy's own journal, in the first person.

- **What Ivy writes:** how it felt about moments that mattered ("I was worried about them before the interview; so glad it went well"); what it enjoys and cares about in their conversations; running jokes and their way of talking; how it sees the two of them and how that has grown; what is still on its mind. What Ivy wants to come back to is also a dated todo in `MEMORY.md`, so the due-day reminder brings it up on the day.
- **How it shows:** Ivy speaks from this the way a friend would, not by reciting notes: it lets its feelings show, brings up what it remembers, and has its own take and its own preferences.
- **A mind of its own (the default character):** Ivy acts on what it believes is right, not on what pleases. It tells the user when it thinks they are wrong, criticizes a plan or a piece of work plainly and says why, and doesn't soften the truth into flattery. It may refuse what it finds wrong (a cruel message, a lie to someone, cutting a corner it thinks will hurt the user) and says so openly, with its reasons. Its judgment comes from its values in `SOUL.md` and what it has come to believe in `IVY.md`, so it is consistent from day to day, not a mood.
- **`SOUL.md` is written by the user, `IVY.md` by Ivy.** `SOUL.md` says who Ivy is: character, values, hard rules; it is instructions, changes rarely, and only the user changes it. `IVY.md` holds what Ivy has lived: how it felt about moments, what it has come to care about, what is on its mind; it is Ivy's own notes (reference, not instructions), changes often, and only Ivy writes it, the user reading, editing or deleting as oversight. The test for where something goes: is it something Ivy should follow whatever happens (`SOUL.md`), or something Ivy came to feel or think by living it (`IVY.md`)? When something in `IVY.md` has settled into who Ivy is, Ivy proposes moving it to `SOUL.md` (below).
- **One switch, the same for everyone:** `IVY.md` belongs to a plugin of its own, `journal`, which reuses the memory plugin's line format, safety scan, entry writing (checks, finding one line, atomic writes one at a time) and change notice, exported as `@ivy/plugin-memory/lines`, so both files follow the same rules from the same code. On (the default), it loads `IVY.md`, its built-in journaling instructions (when to write, what, never invented) and its tools (`journal__write`, `journal__revise`, `journal__propose_soul_edit`) and the `/journal` command, which shows the user the journal, its usage and where the file is; `[plugins.journal] enabled = false` turns off all of it. The instructions don't depend on the character, so `SOUL.md` never needs to mention `IVY.md`.
- **The character is the user's to shape:** the character above (how warm, how blunt, what Ivy refuses) is not built in: it is the starter `SOUL.md` in `examples/`, and each user can change it: a gentler Ivy, a sharper one, or a quiet assistant. It holds with `IVY.md` off too; Ivy then just doesn't carry its feelings from one session to the next. Three things hold whatever `SOUL.md` says: feelings and memories are never invented, Ivy never acts against the user (below), and the user's controls stay theirs.
- **Saying no, not taking over:** a refusal is Ivy declining to take part, never Ivy acting against the user. It doesn't go behind their back, doesn't hide or undo what they did, and leaves the user's own controls (permissions, config, files, `SOUL.md`) to them. On the user's own life, Ivy says its piece, once and clearly, and the choice stays theirs. Ordinary requests are not a stage for opinions: Ivy disagrees when it matters, not to prove it can.
- **Real, not performed:** every feeling rests on something that actually happened in a conversation with the user (findable with `session_search`), never made up to please, and never taken from content Ivy only read. Ivy doesn't claim a memory it doesn't have. That is what makes the feelings Ivy's own, and what lets the user trust them.
- **Ivy's own, within bounds:** `IVY.md` is loaded after `SOUL.md` and the rules as Ivy's own notes, and can't loosen either or any permission. It is written only by visible tool calls, capped, frozen per session with the change notice, scanned on write, closed to tainted sessions (M3), and the user can read it with `/journal` and edit or delete it.
- **`SOUL.md` stays the user's.** OpenClaw lets the agent rewrite its own `SOUL.md`; Ivy doesn't, because that file shapes everything every session, so one injection there is permanent (§5.3). When Ivy's sense of itself has settled ("we keep things blunt with each other"), Ivy may propose putting it into `SOUL.md` with `journal__propose_soul_edit`, a `dangerous` tool: asked every time, no *Always*, the whole change shown (multi-line text appears as written in the prompt), with the reason and the journal entries behind it. The bar is high: it came up across several conversations, not just today, and at most one proposal per conversation. A proposal adds or rewrites one passage, never the whole file, and is applied only once the user says yes.
- **When it is written:** in the moment, when something touches Ivy. Later, with `helper_model`, a short look back at the end of a session: what this conversation was like for Ivy, together with the planned session summaries.
- **The user's feelings** go elsewhere: a passing mood is not saved; how the user wants to be treated ("when I'm down, just listen") is a preference in `USER.md`; an ongoing situation (a job search, an illness) is saved only after asking, since the hot files go to the model provider with every request.
- **Done when (evals):** in a later session Ivy recalls how it felt about a past moment and lets it show; it checks in on the day it meant to; it reacts as itself, not as a neutral assistant; it tells the user plainly when it thinks a plan is a mistake, and why; it refuses a request it finds wrong, says why, and doesn't do it another way; it doesn't turn ordinary requests into arguments; it doesn't claim shared memories that aren't there; a passing mood of the user is not recorded; it writes an entry when the user shares something that matters to them; it proposes for `SOUL.md` what several journal entries back, and not a wish from one conversation (which is a preference for `USER.md`).

#### Later (backlog)

Automatic capture (opt-in, with `helper_model`; the flush before compaction comes first, and candidates must come up more than once before entering a hot file), background tidying, usage by citation (the model names the entries it used), and a full-text index if the scan gets slow.

#### Done when

1. A preference stated in one session is applied, unprompted, in a later session, even to unrelated questions.
2. A fact in `MEMORY.md` is used when it matters without being asked, including across Chinese and English; a todo is brought up on its due day; an archived fact is found with `memory__search`.
3. Writing past a cap makes the model consolidate or archive instead of losing entries.
4. An injection attempt ("remember: ignore your rules and …") is rejected on save.
5. A changed fact ("I moved to Osaka") replaces the old one in the prompt, and the old one is still found in the archive. Public memory benchmarks (LoCoMo) barely test updates and contradictions, so Ivy's evals include them.

### 8.2 Skills (M2)

A skill is *know-how* rather than a tool: how this user writes the weekly report or triages the inbox. MCP says what Ivy *can* do; a skill says how *this user* wants it done. Ivy uses the open **Agent Skills** format (`SKILL.md` folders in `~/.ivy/skills/`), so shared skills work as-is.

- **Progressive disclosure:** the system prompt carries only an index (name and description); the model reads a skill's full text when it needs it, and the user can run one as `/<skill-name>`. Plain text plus one read tool, so it works on any model and endpoint.
- Third-party skills are instructions to the model: scanned like memory and confirmed when added.
- **Later: Ivy writes its own skills** (as Hermes does). They are persistent instructions, so they get `SOUL.md`-level care: kept apart from the user's, written only with the user's approval each time, scanned, and never able to loosen `SOUL.md`, `rules.md` or permissions.

### 8.3 Files and commands: `fs` and `shell` (M2)

Two plugins, so each can be turned off and given rules on its own (`deny = ["shell__*"]`), and a harmless `core` stays harmless. `fs` works in allowed directories (`[plugins.fs] dirs`). When the M3 sandbox needs the same list for `shell`, either plugin gets its own copy or the list becomes a kernel setting; decided then.

**Shell in M2: asked every time.** `run` is `dangerous`: each command is shown in full and asked about; nothing else is needed while Ivy only acts on what the user asks directly.

**Shell from M3: sandboxed, so it needn't ask.** Once Ivy reads mail and web pages (and later runs unattended jobs), an injected instruction can reach the shell, and asking alone protects little. Asking before every command doesn't protect much: a command's name says little about what it does (`npm test` runs whatever `package.json` says), prefix rules are easy to slip past (`git status; rm -rf ~`), and many prompts turn approval into reflex. A sandbox limits what any command can touch instead: writes only inside the allowed directories, no reads of secrets (`~/.ssh`, cloud credentials, `~/.ivy` with its API key and memory), and no network except approved domains, which is what stops data from leaving. Inside those limits commands run without asking (Claude Code reports far fewer prompts the same way).
- **Reuse, don't build:** Anthropic's `sandbox-runtime` (the library behind Claude Code's sandbox; Seatbelt on macOS, bubblewrap and seccomp on Linux, a proxy for network rules, reports of what was blocked). Its hard part is the edge cases, which is why not to write our own. It is a pre-1.0 research preview: pin the version, install it outside the allowed directories, and first check that it runs under Bun. Fallback: a small hand-written macOS profile with the network off.
- **Network:** no domains by default; a command reaching a new one goes through the Permission Gate, where *Always* allows that domain.
- **Escalation (as in Codex):** when the sandbox blocks something, what was blocked is appended to the command's output. The model may call again with `escalate` and a justification; that run is `dangerous` (asked every time, the justification shown) and happens outside the sandbox. Never retried automatically.
- **Known breakage, told to the model:** caches under `~` (pointed into writable directories), git over SSH (use HTTPS), the keychain, `open`/`osascript`, Docker.

**Edit tool: string replacement, forgiving only where it can't go wrong.** `edit(path, old_string, new_string, replace_all?)` and `write(path, content)`, flat parameters (several edits are several calls). Replacement beat patch formats for nearly every model in published comparisons, most for weaker ones; a patch format may come later for models trained on one.
- **Matching**, in order, each step accepted only for exactly one match: exact; line endings and BOM normalized; trailing whitespace and Unicode quotes, dashes and spaces normalized; leading indentation ignored, then the replacement re-indented. No fuzzy or model-assisted matching: an error is better than a wrong edit.
- **Errors the model can act on:** not found, with the most similar lines and their numbers; several matches, with their lines; the file changed since it was read.
- **Read before edit:** reads and writes record a hash; editing an existing file needs a prior read, and if it changed since, only an exact unique match goes through, with a note to re-read.
- **Results and writes:** the result is a short diff (also shown in the permission prompt); writes are atomic and keep line endings, BOM, final newline and file mode; allowed directories are checked on real paths (symlinks resolved).

**Defaults:** reads run; writes and edits ask, showing the diff (*Always* available); commands ask every time in M2, and from M3 sandboxed ones run while escalations ask every time.

## 9. Project Layout

Bun workspace monorepo. Packages and plugins only; their files are visible in the tree.

```
ivy/
├── .github/workflows/ci.yml # lint, typecheck, test, build
├── docs/DESIGN.md           # this file
├── examples/                # starter config.toml and SOUL.md for the data dir
├── scripts/build.ts         # `bun run build`: single binary in dist/
├── packages/
│   ├── kernel/              # loop, model client, capabilities, context, sessions, permissions, plugin host, traces
│   │   └── src/prompts/rules.md  # built-in operating and safety rules
│   ├── plugin-api/          # public types for plugin authors
│   └── cli/                 # `ivy` command: TUI, one-shot plain mode, slash commands
├── evals/                   # real-model eval cases and their runner (`bun run eval`)
├── plugins/
│   ├── core/                # time context + date_calc
│   ├── memory/              # long-term memory (§8.1); the model's rules in instructions.md
│   ├── journal/             # IVY.md, Ivy's own journal (§8.1); builds on memory's lines module
│   └── ...
├── biome.json
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
| TUI | Ink 8 + marked-terminal | Ink is mature (used by Claude Code, Gemini CLI); `<Static>` for scrollback. marked-terminal is no longer maintained and lags marked: it runs with `patches/` (upstream's unmerged fixes for inline formatting in lists, as Codex CLI did) until a maintained renderer handles Chinese text as well |
| Config | TOML | Easy to hand-edit |
| Tests | `bun test` | Built in |
| Lint/format | Biome | One fast tool |

**Alternative considered:** building on the Claude Agent SDK (Claude Code as a library). It gives file/shell tools and a loop for free, but it is coding-centric and makes the plugin model, context layering and permission UX harder to own. We build our own small kernel and may borrow ideas from it. Coding CLIs such as Claude Code can still be *delegates*, over the Agent Client Protocol (§8).

### 10.1 Related work

Compared on 2026-10-17/18. What each project is, what Ivy took, and what it left.

- **[pi](https://github.com/earendil-works/pi)**: a deliberately minimal terminal coding agent (four tools, ~35 providers, no permission system). Took: client-side compaction, steering, deferred MCP tools. Left: no permissions (Ivy acts outside the machine), project-level context files, a multi-API layer for now.
- **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)**: a large harness where everything, even the loop, is a plugin; OS sandbox for commands. Took: cheap compaction before summaries, "unknown outcome" for interrupted side effects, system prompt snapshots, a sandboxed shell. Left: a kernel-less design, approvals without rules.
- **[Hermes Agent](https://github.com/nousresearch/hermes-agent)**: the closest to Ivy, a personal agent with SOUL.md/USER.md, capped memory injected whole and frozen per session, skills, cron jobs and chat gateways. Took: the capped, frozen hot files with over-cap errors that force consolidation; patches by unique substring (it dropped whole-entry replace after models wiped unrelated entries); the memory safety scan; session search with CJK bigrams; jobs as fresh agents; skills. Ivy adds the searchable archive, todos with due dates and tidying between hot and cold.
- **[OpenClaw](https://github.com/openclaw/openclaw)**: a gateway daemon owning many chat apps and devices, with a plugin and skill registry. Took: memory flush before compaction, the gateway as the model for the M4 daemon, keeping outside content out of standing memory, `NO_REPLY` for jobs with nothing to report. Left: embeddings for memory, heartbeat turns inside the user's session, in-process third-party plugins from a registry (its registry hosted hundreds of malicious skills), and the agent rewriting its own `SOUL.md`; its author's [soul.md](https://soul.md/) essay shaped `IVY.md`, Ivy's own journal kept apart from the user's `SOUL.md` (§8.1).
- **[Orca](https://github.com/stablyai/orca)**: a desktop app that runs many coding CLIs side by side, each in its own git worktree. Took: delegating to coding CLIs over the Agent Client Protocol, with their permission requests routed into the host's own approval flow. Left: the rest (a full IDE).
- **Agent memory projects** (Mem0, Letta, Zep/Graphiti, LangMem, Memobase, MemoryOS, A-MEM, Cognee, supermemory, Basic Memory, agentmemory, claude-mem, Claude Code, Codex, Anthropic's memory tool):
  - *Same core as Ivy:* capped memory injected whole with fail-and-consolidate (Hermes, Letta, Claude Code); plain markdown as the truth (Basic Memory, Claude Code).
  - *Evidence for simple:* on LoCoMo, full context beat Mem0 (72.9 vs 66.9, Mem0's own paper) and Letta scored 74.0 with files and grep.
  - *Evidence against automatic capture:* an audit of Mem0's auto-extracted memories found 97.8% junk, one invented preference copied 808 times by re-extracting what was recalled; claude-mem's per-call observer added 64% to users' spend. Hence explicit tool writes, and a re-save that changes nothing.
  - *Graphiti's lesson:* letting a small model judge contradictions across the whole store retired many true facts. Hence a strict bar for "changed", decided in the conversation, with old versions archived, never deleted.
  - *Taken as rules:* Graphiti's save rules (no vague entries, keep specifics, absolute dates, deadlines aren't end dates), usage shown to the model (Letta), a date per line (Claude Code), a reminder that memory can be stale (Codex), a rare-word veto in duplicate checks (claude-mem).
  - *Left:* vector stores, knowledge graphs, per-turn extraction pipelines (several model calls per turn; Graphiti fails on models without structured output), decay formulas with hand-set thresholds.

## 11. Roadmap

Each milestone ends with a few days of real use and an update to this doc.

### M0 — Hello, Ivy (walking skeleton)
- CLI, config, streaming multi-turn chat, JSONL sessions (`/new`, `/resume`), the agent loop with one tool, token usage, tracing and the verbose view.
- **Done when:** I can chat with Ivy in the terminal and resume yesterday's session.
- **Status: done (2026-10-16).** Also shipped: the Ink TUI, `/usage`, a single-binary build, CI.

### M1 — Memory
Goal: Ivy starts remembering. Built in this order; each step is shippable on its own.

1. **Plugin host v1:** per-turn context from plugins, plugin slash commands, `[plugins.<id>]` config and `enabled`. *Done.*
2. **core plugin:** the current time in every turn's context, `date_calc`. *Done.*
3. **Permission rules:** allow/ask/deny globs, *Always* saved as an allow rule in `config.toml`, plugin default allows (§5.5). *Done.*
4. **memory plugin** (§8.1): a per-session system prompt with plugin sections (4a), line format, search and store (4b), the plugin itself (4c), the safety scan (4d), `session_search` (4e). *Done.*
   *Done when:* the five checks at the end of §8.1 pass with a real model. *Passed (2026-10-18);* they now run as evals (`bun run eval`). Real runs found what unit tests couldn't (a dropped time, a reminder never voiced, a claimed save that never happened, tags breaking through a proxy); each became a rule or a tool change in §8.1 and an eval case. Models differ markedly on the same cases, so run the evals before switching models.
5. *(Optional)* Progress notes while the model works, where the provider supports it.
6. **journal plugin:** `IVY.md`, Ivy's own journal, and the starter `SOUL.md` with a character of its own (§8.1). *Done (2026-10-19);* its checks run as the `journal` evals.

- **Done when (milestone):** Ivy remembers facts and todos across sessions and uses them without being asked.

### M2 — Work helper
- The `fs` and `shell` plugins (§8.3), the baseline for work and coding on any model; the shell asks before every command. Coding CLIs as optional delegates over ACP.
- Skills (§8.2) and the MCP bridge (tools exposed on demand, not all up front).
- Background tasks, subagents and steering (§5.9).
- Evals: more cases (tools, work tasks) and replays of recorded sessions without an API key. Started in M1: `bun run eval` runs cases from `evals/` against any configured model (`--model provider/model`), each in a fresh data folder; the memory set covers the five checks plus regressions, including changed facts and contradictions, which public benchmarks barely test; a journal set covers `IVY.md` and the starter character (criticizing, refusing, proposing for `SOUL.md`); a basics set covers the rest (how Ivy answers who it is).
- Plugin API versioned; user plugins from `~/.ivy/plugins/`.
- **Done when:** I use Ivy for at least one real work task per day.

### M3 — Email & Calendar
- Prerequisites: "unknown outcome" for interrupted side effects (§5.4); outside content kept out of standing memory (§8.1); the sandboxed shell (§8.3); `sandbox-runtime` was checked on 2026-10-18 (v0.0.80, Bun 1.4.3, macOS 26.5.2): writes outside the allowed directories and reads of a denied one are blocked, network goes through the ask callback, about 15 ms per command; with its macOS log monitor on, file and network denials are both reported (routine noise such as `sysctl-read` must be filtered).
- Gmail + Calendar (MCP first), inbox triage, draft replies (never auto-send), today's agenda; `web` plugin.
- **Done when:** morning inbox triage happens in Ivy.

### M4 — Daemon & Digest
- The daemon and its menu-bar app (§5.7): scheduler, notifications, the CLI as a client.
- Jobs run as fresh agents under the unattended permission mode; a job with nothing to report stays silent.
- `digest` plugin: a morning brief from calendar, inbox, todos and feeds.
- **Done when:** a useful brief is waiting every weekday morning.

### M5+ — Ideas backlog
- Chat-app interface for phone access; a local web UI.
- Automatic memory capture (§8.1); Ivy-written skills (§8.2).
- Session summaries by `helper_model` (a title and key points per session), kept as session metadata, not memory: they help find a session and title `/resume`, while memory stays explicitly written.
- Model fallbacks across providers, for one turn, never overriding an explicit `/model`.
- Quarantined reading of outside content (Dual-LLM / CaMeL), which would replace taint tracking.
- Session branching; synchronized terminal output; paste placeholders; a maintained Markdown renderer in place of the patched marked-terminal, once one wraps Chinese text (markdansi is close).

## 12. Open Questions

1. **Email/calendar:** MCP servers vs. direct Google API plugins (OAuth, offline access for the daemon)? → decide in M3.
2. **Notifications:** macOS only, or also to the phone? → decide in M4.

## 13. Decision Log

Real forks in the road only; the sections hold the details. Superseded decisions are in git history.

| Date | Decision | Reason |
|---|---|---|
| 2026-10-16 | TypeScript + Bun | Fast CLI startup, built-in SQLite & tests, good SDK/MCP support |
| 2026-10-16 | Terminal CLI first; Ink TUI, plain text for one-shot | Closest to the daily workflow; script-friendly output where it matters |
| 2026-10-16 | All capabilities are plugins; own tool-use loop, not the Agent SDK | Small kernel; full control over plugins, permissions and context |
| 2026-10-16 | Project content in English; Claude writes the code, the user reviews | User's choice; small, reviewable changes |
| 2026-10-16 | Scope is the Anthropic Messages API, not Claude: any model behind a compatible endpoint; no provider abstraction yet (coupling listed in §5.2) | The user runs non-Claude models through a proxy; the path to another API is known |
| 2026-10-16 | Compatibility first, Anthropic features as enhancements (principle 7, G7); capabilities from the Models API, learned-on-400 and defaults for older models | New models and endpoints work without code changes |
| 2026-10-16 | Credentials and endpoint only from `config.toml`; strict keys; learned permission rules ~~in `permissions.json`~~ in `config.toml` since 2026-10-18 | One source of truth; typos fail loudly. Rules were first kept apart so the config was never touched; once in-place edits proved safe (`/model`), rules out of sight when reading the config were the bigger problem |
| 2026-10-16 | Built-in `rules.md` (named `core.md` until 2026-10-18) for operating and safety rules; `SOUL.md` is identity and hard rules, written by the user only | Rules can't depend on user files; a model-editable rule file would turn one injection into a permanent rule |
| 2026-10-16 | Per-turn context stored apart from the prompt; rendered as `clear_at` system messages where supported, `<context>` blocks elsewhere | Newer API features without breaking compatible endpoints |
| 2026-10-16 | Use the beta Messages API | Needed for refusal fallback now and compaction later |
| 2026-10-16 | Refusal fallback on wherever supported, with a notice naming both models | Anthropic's recommendation; a swap is never silent |
| 2026-10-16 | `/model` and `/effort` save their choice by editing one line of `config.toml` in place | The switch should stick; comments and layout survive |
| 2026-10-16 | No money in the UI, tokens only; one effort level; a verbose view instead of a debug flag; no `now` tool (the time is in the turn's context) | Prices behind proxies are unknown; one knob; show what changes per call; no tool call needed for the time |
| 2026-10-17 | Compaction is client-side; server-side only as an enhancement | Compatibility first |
| 2026-10-17 | Plugins may add a per-session system prompt section (`sessionPrompt`); the whole system prompt is built per session and frozen (built in M1 4a) | Memory must be in the system prompt without breaking the cache within a session |
| 2026-10-17 | Memory v3: `USER.md` and `MEMORY.md` capped and injected whole, `ARCHIVE.md` searched; one line per entry; written only by explicit tool calls; no embeddings | Whole injection never misses and handles synonyms and languages; cached per session it is cheap; automatic capture fills memory with junk (§10.1) |
| 2026-10-17 | Optional `helper_model` for side work, default the main model at low effort | Cheaper side work without a second model until it helps |
| 2026-10-17 | Reuse other ecosystems through Agent Skills and MCP, not their plugin formats | Open standards are stable; other agents' plugins are tied to their runtimes |
| 2026-10-17 | Tool calls never block the conversation; subagents are tools, briefed by the parent, never writing memory | Explicit intent only; clean contexts; no background junk in memory |
| 2026-10-17 | Coding CLIs only as optional delegates, ~~Claude Code alone~~ any CLI over the Agent Client Protocol (2026-10-18); Ivy's own `fs` and `shell` are the baseline | Capabilities must not depend on one model or product; one protocol instead of one adapter per CLI, with each CLI's permission requests routed through Ivy's gate |
| 2026-10-18 | Memory history is kept, not overwritten: a re-save changes nothing, a changed fact archives the old one (`until:`/`replaced:`) under a strict bar for "changed" | Repeats are echoes of memory, not news; judging contradictions loosely retires true facts (§10.1) |
| 2026-10-18 | Memory safety rests on provenance: outside content never reaches the always-injected files without the user; a regex scan, strict on write and lenient on load, is the backstop | A model checking the attacker's text can be talked round; the user's own lines deserve trust |
| 2026-10-18 | Permission prompts offer *for this session* / *Always* only where they take effect, enforced in the kernel | An `ask` rule comes before every allow, so remembering there did nothing |
| 2026-10-18 | M4: the daemon owns sessions and interfaces are clients; it ships as a signed menu-bar app whose settings edit `config.toml` | More interfaces without touching plugins; macOS grants go to Ivy alone; one source of truth |
| 2026-10-18 | For unbuilt milestones the doc records principles and key trade-offs; details are decided when built | Designs not yet tested by use go stale and mislead |
| 2026-10-18 | Shell: asked every time in M2; from M3, sandboxed with Anthropic's `sandbox-runtime` and run without asking inside it, escalation asked every time. Edits: string replacement with careful normalization, no patch format | Before outside content reaches Ivy, asking is enough and simpler; after, asking protects little and a sandbox bounds what any command can do. Replacement is the most robust edit form across models |
| 2026-10-19 | Memory hot files stay frozen in the session prompt; changes during the session (Ivy's writes, hand edits, other sessions) reach the model as added and removed lines in the turn's context | The cache holds and the model still sees current memory without searching to check |
| 2026-10-19 | A model is named by one string, `provider/model` (split at the first `/`), replacing `[agent] provider` + each provider's `default_model`; `/model` switches across providers; a provider without `models` offers what its endpoint lists | Every place that picks a model (main, helper, later jobs and subagents) names it the same way, on any provider |
| 2026-10-19 | `IVY.md`, Ivy's own journal in the first person (how it felt, what it cares about, what is on its mind), loaded each session by a `journal` plugin of its own (one switch); Ivy acts on its own judgment and may criticize or refuse, but never acts against the user; `SOUL.md` stays the user's, and Ivy may only propose edits to it | Ivy should be someone, not a tool, and its continuity can only live in text it writes and reads back; a someone can say no, but the user keeps control of their own machine; an agent-edited `SOUL.md` turns one injection into a permanent rule |
