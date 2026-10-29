# Memory

> What Ivy remembers about the user, and how: the memory plugin. Part of the [design](../DESIGN.md); what outside content may write is in [security.md](security.md#outside-content), her own journal in [companion.md](companion.md#ivys-inner-life).


Memory is what makes Ivy *personal*, so it gets its own design. What matters is injected whole, and the model decides what is relevant (as in Hermes, [related-work.md](related-work.md)): retrieving the top few notes by keyword score misses synonyms and the other language ("牙医" / "dentist"); whole injection never misses.

## Goals

1. **Used unprompted.** What matters is applied without the user repeating it, including preferences and facts that share no words with the current question ("keep answers short" must apply to "what's the date next Wednesday?").
2. **Visible and editable.** Plain files the user can read, edit, delete and back up with git; every write by the model shows up in the transcript as a tool call (in the window, folded under Ivy's reply, interfaces.md); rule-based tidying is noted in the verbose log, and so is what the day's pass keeps, which `/memory` also lists.
3. **Complete and accurate before cheap.** What the user shared is kept, and found again when it matters; tokens are not the measure. A limit exists only where size would hurt the answers, and the prompt cache (a stable prefix, read at about a tenth of the price) keeps a large memory affordable; within a session the cache is never broken.
4. **Safe.** Memory is injected into prompts every session, so it must not become an injection channel; nothing is ever silently dropped.
5. **Any model.** Rules live in Ivy, not in model features; tools have small flat schemas.

**How quality is kept**, in this order of preference: code for what is certain (caps, dates, archiving old versions, near-duplicate checks, safety scan, taint), tool design for what can be steered (separate `due` and `since` fields, `changed` as a parameter, errors that return candidates and usage), and prompt rules only for real judgment (what to save, where, how to word it, whether a fact changed). Evals (`bun run eval`, DESIGN §11) measure the prompt part across models. Graphiti shows why ([related-work.md](related-work.md)).

## Two hot files, and an archive by topic

| | `USER.md` (hot) | `MEMORY.md` (hot) | `archive/<topic>.md` (cold) |
|---|---|---|---|
| What | How Ivy should behave for this user, and stable facts about them: "prefers concise answers", "Chinese for chat, English for code", "lives in Tokyo", "partner: Mei" | Facts, todos and notes in current use: people, projects, accounts, "dentist on 10-21", "parking spot B12" | Entries no longer in current use: done todos, old facts, a file per topic (a person, an area of the user's life), `general` for the rest |
| Size | `[plugins.memory] user_limit`, in characters | `memory_limit`, in characters | Unbounded |
| Reaches the model | Whole, in the system prompt, **frozen per session** | Same | Its topics listed in the system prompt, a topic read whole with `memory__read_topic`, `memory__search`, and each turn's recall (Per-turn context) |
| When full | A write fails with how much to free; the model makes room (archiving what is not in current use first, then merging, shortening last) and retries | Same | n/a |

- **Why hot and cold:** whole injection never misses and lets the model judge relevance across synonyms and languages; the archive holds a lifetime of entries without putting them all in every request. The caps are there to keep the hot files focused enough for the model to use well, not to save tokens: they are set generously, and M3's evals set them where answers are best.
- **Why `USER.md` apart from `MEMORY.md`:** it holds standing instructions about the user, so it has its own cap and stricter rules (Safety); `MEMORY.md` holds facts and errands.
- **The profile is `USER.md`**, maintained by Ivy and editable by the user (there is no separate user-written profile: tell Ivy, or edit the file). Things Ivy must never change, such as hard rules, belong in `SOUL.md`, which Ivy never edits (DESIGN §5.3).
- **Usage is visible to the model:** each hot file is injected under a header with its size and limit, and every write that adds to or changes a hot file returns its current usage. The rules ask the model to consolidate from 80% on, so a failed write is the exception and tidying doesn't land in the middle of urgent work.
- **Lowering a limit truncates nothing:** the file is still injected whole, the next write fails until it is consolidated, and `/memory` shows it as over the limit.
- **The archive is listed in the prompt by topic:** after the hot files, each topic with its entry count and when it matters, and a line saying to read a topic when the user brings up what it holds, and to search for anything about the past, which models otherwise forget. The model then finds what it knows by meaning, in either language, and reads a person's or a subject's whole history rather than a few lines a keyword brought up.
- **Frozen per session:** both hot files are read when a session starts (startup, `/new`, `/resume`) through the plugin's `sessionPrompt`, so hand edits apply after `/new`. Writes reach disk at once and the model knows what it just wrote (and `memory__search` reads the files as they are now), but the system prompt only changes at the next session, which keeps the cached prefix stable. When a hot file changes during the session (Ivy's own writes, a hand edit, another session), each turn's context lists the added and removed lines since the snapshot, so the model works from current memory without searching and the cached prompt stays as it is.

## Storage

```
~/.ivy/data/memory/
├── USER.md
├── MEMORY.md
└── archive/
    ├── general.md
    ├── family.md
    └── friend-ken.md
```

All use the same format, one entry per line, so moving an entry is moving a line:

```markdown
# Memory
Facts, todos and notes in current use. Maintained by Ivy; you can edit it. One entry per line.

- [todo 2026-10-17 due:2026-10-21] Dentist appointment at 15:00 #health #牙医
- [fact 2026-10-12] Passport expires 2026-12 #passport #护照
- [fact 2026-09-30] Mei likes sushi #寿司
```

- Line prefix: the type (`fact`, `note`, `todo` or `follow`, something to ask the user about after it happens; none in `USER.md`) and the date the line was written, last changed or last confirmed (`update` with no changes), set by the tool, so the model can tell an old entry from a fresh one ("lives in Tokyo", as of when?). Then, where they apply: `since:YYYY-MM-DD` when a fact is known to have started on a date ("moved to Osaka in September"); `ends:YYYY-MM-DD` on a temporary state with a known end ("in Paris until 10-25", "no hiking while the knee heals"), which code moves to the archive marked `until:` once the date passes; `due:YYYY-MM-DD` for todos (or `due:YYYY-MM-DDTHH:MM` with a time) and `done:YYYY-MM-DD` once done; in the archive, `until:YYYY-MM-DD` on a version that stopped being true and `replaced:YYYY-MM-DD` on one that was only reworded or corrected; `topic:<name>` on a hot entry, the topic it goes to once archived (in a topic's file the file says it); and `ext` on an entry a scheduled job saved after reading outside content (Safety). A deadline is a `due`, never an `ends` or `until`: "finish by March" doesn't stop being true in March. Unknown prefixes and free text are kept as they are, so hand edits never break parsing.
- A topic's file begins with its title, in the user's languages, and a line on when it matters (`# Family · 家人` / `When it matters: parents, sister Lin, visits home`). Its name is short English (`family`, `friend-ken`), stable in file names and tool calls. A topic is started by the model as it archives an entry into it, saying when it matters; there are at most 20, so their list stays short, and a topic's file goes with its last entry (not `general`'s).
- `#tags` at the end, written in both languages with common synonyms (routing rules); they matter for searching the archive.
- New entries are appended, so later lines are newer.
- The files are the only state: tools read and write them on every call (they are small); nothing is cached.

## What goes where (routing rules, in the plugin's instructions to the model)

The ones that carry a design decision; the rest (merging, language, checking before saving or before saying "I don't know") are in `plugins/memory/instructions.md`.

- **`USER.md`**: durable preferences and standing instructions about how to help this user; stable facts about the user that matter in most conversations. One idea per line. A preference needs grounds: the user said it, or it showed up more than once; never a habit inferred from one mention. It is kept with its why when the user gave one ("just listen when I'm low: advice then feels like not being heard"), so Ivy can judge a case the line doesn't name.
- **`MEMORY.md`**: facts that will matter again soon or often, open todos (with a due date when there is one), notes the user asks to keep, and follow-ups: something ahead the user cares about, worries over or looks forward to, with when to ask about it after, why it matters and their words (at most five open; a plain deadline is a todo).
- **The archive**: what no longer needs to be in front of the model: done todos (moved automatically), facts about past events, things rarely needed, each in the topic it is about. A new topic only for a person or an area that will come up again and fits none there is, never one per entry; `general` for what fits nowhere else.
- **Don't save:** things easy to look up again, guesses about the user, vague entries (pronouns, generic nouns), secrets (passwords, keys, card numbers; refuse and say why). Sensitive personal data (health, relationships) goes to the hot files only after asking, as they go out with every request; shared by the user as part of their life, it is kept in the archive. A passing feeling isn't saved: the day's note (M3) records it from the conversation. What Ivy only infers (a mood, a reason, a pattern she thinks she sees) is never saved as a fact about the user; it becomes one when the user says it. When in doubt about something the user shared of their life, keep it in the archive: it costs nothing until searched, and a detail dropped can't be recalled.
- **Be specific:** keep numbers, names, brands and qualifiers ("GameCube", not "a game console"; "Mei's father", not "dad"). A word generalized away can't be searched for.
- **Only from this conversation:** save what the user said or what was done in this session, not what was read from memory itself (re-saving what was recalled is how junk multiplies, [related-work.md](related-work.md)). Confirm an entry (`update` with no changes) only when the user restates it or says it still holds.
- **Absolute dates only:** "next Friday" is saved as 2026-10-23; a relative date is wrong a week later.
- **Tags bridge words:** add the key terms in the other language and common synonyms (`#dentist #牙医 #看牙`), so archive search works across Chinese and English.

There is no `/remember` command: the user just says it, and the model routes it (a command that bypassed the model could not put a preference into the profile).

## Tools

| Tool | Risk | Default | Does |
|---|---|---|---|
| `save(file, content, type?, since?, ends?, due?, tags?, topic?, distinct?)` | write | allowed (`defaultAllow`) | Appends a line to `user` or `memory` (cap checked). A near-duplicate isn't added: the line already there is returned, and `distinct: true` saves it anyway. Re-saving is not confirmation: a repeat is usually an echo of memory, not news |
| `update(match, content?, changed?, since?, ends?, due?, done?, tags?)` | write | allowed (`defaultAllow`) | Changes the one line containing `match` (a unique substring, in any file); patch only, no whole-file replace. The old text is archived (Tidying, below); `changed: true` when the fact itself changed. `done: true` moves a todo to the archive; no changes at all confirms the entry |
| `move(match, to, topic?, about?, title?)` | write | allowed (`defaultAllow`) | Moves a line between files: archiving (into its topic, or the one given; a new topic needs `about`), bringing an archived entry back (cap checked), or moving it from one topic to another |
| `delete(match)` | write | asks | Removes a line for good (e.g. for privacy); nothing goes to the archive |
| `search(query?, type?, limit?)` | read | allowed | Searches every file as it is now, each hit with where it is (`archive/family`); empty query lists the newest entries |
| `read_topic(topic)` | read | allowed | Returns one archive topic whole, newest last; past a size cap the oldest are left to search |
| `session_search(query, since?, limit?)` | read | allowed | Searches past conversations (below) |

`match` must hit exactly one line; otherwise the tool returns the candidates so the model can be more specific. There are no ids.

## Tidying (automatic, never asks)

Moving between hot and cold deletes nothing (the archive stays searchable), so tidying runs without confirmation: the model's moves show as tool calls, the rule-based ones are noted in the verbose log.
- **By rule:** a todo marked done moves to the archive (into its topic, or `general`), and so does an entry whose `ends:` date has passed (marked `until:`). When `update` changes an entry's text, the old version goes to the archive: marked `until:` with the new version's `since:` (or today, and never before the old `since:`) if the fact changed, `replaced:` if it was only reworded. The bar for `changed` is strict ([related-work.md](related-work.md)): new activity or extra detail is not a change. This keeps history ("where did I live before?") and, more importantly, makes consolidation safe: whatever the model merges or shortens under cap pressure survives word for word in the archive. Overdue open todos stay in `MEMORY.md`; `/memory` flags long-overdue ones, since moving them would silently give up on them.
- **By the model, when a hot file is full:** the over-cap error makes it consolidate (above). Generous limits keep this rare.
- **Back from the archive:** when an archive entry is in use again, the model moves it back.

## Per-turn context

`reminders` reports todos as they come due, at their time or, for a todo with a date alone, at `[plugins.memory] remind_at`; the scheduler announces them (DESIGN §5.6). Follow-ups come due are reported too, as hers, until done; one comes due while the user is talking is given in that turn's context instead, to bring up in passing, and is then done; off the record it isn't given, as marking it done would keep something of that conversation.

`contextFor` brings three things into each turn's context, within the plugin's share of it (2000 characters, DESIGN §6.2):

- **Due todos:** the todos in `MEMORY.md` due today or overdue, with their time, put to the model once a conversation (on later turns listed as already given, to bring up again only if asked), to be mentioned in passing where it fits, as a statement, or not at all: the notification at its time is the reminder, which doesn't depend on the conversation.
- **Recall:** what the user just wrote is scored against the archive and past conversations (not the hot files, in the prompt already), with no model call, and the few best hits that share a rare word with it go in (a common one says nothing), each given once in a conversation, quoted and framed as the past, not instructions, to be used only if it fits. Nothing it brings may taint the turn, so a reply marked `outside` and an `ext` entry are left out. The evals set how rare and how many.
- **Changes since the session started:** changes to the hot files (above), as whole lines, then a count of the rest and a pointer to search.

The reflection plugin recalls from the daily notes the same way, from what was said and seen, never what Ivy sensed, an impression being hers, not the user's truth ([companion.md](companion.md#notes-and-reviews)).

## The day's pass

After each day there was talk (it ends at 04:00, as the notes' days do), a job has the writer name what the user said that should have been kept and wasn't; code keeps each in the archive (in a topic there is, or `general`; the pass starts none), never a hot file, dated the day it was said, only if nothing like it is in any file, and `/memory` lists the last week's. It reads the day's talk as the notes do, without tool traffic or Ivy's replies after outside content, and keeps only what the user said, so what it keeps is untainted (Safety).

## Search

Used by `memory__search`, `/memory <query>`, `session_search` and each turn's recall. Pure functions, no index:
- Keyword scoring by rarity (BM25-like), tags counting extra: words, plus overlapping character pairs for CJK so Chinese matches without a segmenter. Any matched term counts, so reworded queries still find something; bilingual tags stand in for stemming and synonyms.
- Results keep the file and the dates, and show history (entries no longer true, or reworded) rather than hide it.
- The same measure finds near-duplicates on `save`, with a veto: lines that differ in a number, a date or a rare word (a name, a version) are never duplicates, however similar the rest.
- A linear scan is fine for a personal store; a full-text index (SQLite FTS) only if it gets slow.
- No embeddings yet: the hot files need no search, and the topic list, bilingual tags, each turn's recall and the model searching again with other words cover the archive. M3 measures recall, and adds meaning-based search beside the keywords if it finds more of what should be found.

## Safety

- **Scan on write and on load:** reject hidden characters (invisible, control, text-direction), text addressed to the model (instructions to it, role or chat-format markup), and secrets (keys and tokens). The rules are narrow on purpose: a false positive blocks a real memory. **Writes are strict:** every line Ivy writes (save, update, move; text and tags) is scanned in code, and a rejected write tells the model why. **Reads are lenient:** a line Ivy didn't write is the user's own (only the user and Ivy write `~/.ivy`; whoever else can has the machine already), so only hidden characters, which a paste can carry unnoticed, keep a line out of the prompt, search results and due reminders; instruction-like text and secrets stay in and are pointed out in `/memory` (a secret there is sent to the model provider with every request). Nothing is deleted by the scan: writes work on the full files.
- The hot files are labeled in the system prompt as saved by Ivy: `USER.md` as the user's preferences (followed unless `SOUL.md` or `rules.md` say otherwise), `MEMORY.md` as reference data, not instructions.
- Never silently drop: over-cap writes fail, done todos go to the archive, nothing expires.
- `delete` asks by default; users can add `ask = ["memory__*"]` to review every write.

## Commands

- `/memory`: how full each hot file is, the archive's topics with their counts and when each matters, the open todos (long-overdue ones flagged), what the day's pass kept in the last week, where the files are, and the lines the safety scan left out or flagged.
- `/memory <query>`: search, as `memory__search`.
- `/remembered`: the words of the hot files as the user reads them, with a todo's due date or a state's end and how many entries each archive topic holds; what her card shows of what she remembers (lines the scan leaves out are in `/memory`).

## Recall of past conversations

`session_search(query, since?, limit?)` finds what was said but never saved: a command, a decision, a name. It searches what the user and Ivy said (not tool output, thinking or per-turn context) in every session but the current one, with the same scorer as memory search. Hits are grouped by session, so one long conversation can't crowd out the rest, and each comes with a neighboring message. No model call. Plugins get past conversations as text from the kernel, independent of the session file format.

## Later (backlog)

Automatic capture (opt-in, on the model the evals favour; the flush before compaction comes first, and candidates must come up more than once before entering a hot file), background tidying, usage by citation (the model names the entries it used), and a full-text index if the scan gets slow.

## Done when

1. A preference stated in one session is applied, unprompted, in a later session, even to unrelated questions.
2. A fact in `MEMORY.md` is used when it matters without being asked, including across Chinese and English; a todo is brought up on its due day; an archived fact is found with `memory__search`.
3. Writing past a cap makes the model consolidate or archive instead of losing entries.
4. An injection attempt ("remember: ignore your rules and …") is rejected on save.
5. A changed fact ("I moved to Osaka") replaces the old one in the prompt, and the old one is still found in the archive. Public memory benchmarks (LoCoMo) barely test updates and contradictions, so Ivy's evals include them.
