# Ivy

A personal AI agent, in the terminal and a Mac app, on any model behind Anthropic's Messages API or OpenAI's Chat Completions. See [docs/DESIGN.md](docs/DESIGN.md).

```bash
bun install
mkdir -p ~/.ivy && cp -n examples/* ~/.ivy/   # then set a provider and its key in ~/.ivy/config.toml, or in the app's Settings
bun run ivy            # chat; `-c` continues the last session, `-v` shows verbose details
bun test && bun run typecheck && bun run lint
bun run eval           # real-model evals (costs tokens): `bun run eval memory --model <provider>/<model>`
bun run build          # single binary at dist/ivy (prompts are embedded)
bun run build:app      # the app at app/build/darwin-arm64/Ivy.app; --install copies it to /Applications, --dmg makes a disk image
bun run build && (cd app && IVY_BIN=../dist/ivy go tool mygo dev)   # the app, its chat window hot-reloading
```

All data (config, `SOUL.md`, sessions, traces, plugin data) lives in `~/.ivy/`, shared with the app; set `IVY_HOME` to use another folder (e.g. a fresh one to start over).

Ivy runs in a background daemon that `ivy` starts when none is running (its log: `~/.ivy/daemon/daemon.log`); it exits after 30 idle minutes, and the next `ivy` replaces it when the code has changed since it started.

## License

MIT, see [LICENSE](LICENSE).
