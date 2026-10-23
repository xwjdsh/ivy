# Ivy

A personal AI agent, in the terminal and a Mac app, on any model behind Anthropic's Messages API or OpenAI's Chat Completions. See [docs/DESIGN.md](docs/DESIGN.md).

```bash
bun install
mkdir -p ~/.ivy-dev && cp -n examples/* ~/.ivy-dev/   # then set a provider and its key in its config.toml, or in the app's Settings
bun run ivy            # chat; `-c` continues the last session, `-v` shows verbose details
bun test && bun run typecheck && bun run lint
bun run eval           # real-model evals (costs tokens): `bun run eval memory --model <provider>/<model>`
bun run build          # single binary at dist/ivy (prompts are embedded)
bun run build:app      # "Ivy Dev", in app/build/darwin-arm64; --install builds your Ivy into /Applications, --dmg as a disk image
bun run build && (cd app && IVY_BIN=../dist/ivy go tool mygo dev)   # the app, its chat window hot-reloading
```

Your Ivy (the installed app and its `ivy` command) keeps all its data (config, `SOUL.md`, sessions, traces, plugin data) in `~/.ivy/`. Everything run from source, and "Ivy Dev", uses `~/.ivy-dev/` instead, with its own daemon and Keychain entries, so development never touches your conversations. `IVY_HOME` points either at another folder.

Ivy runs in a background daemon that `ivy` starts when none is running (its log: `daemon/daemon.log` in its folder); it exits after 30 idle minutes, and the next `ivy` replaces it when the code has changed since it started.

## License

MIT, see [LICENSE](LICENSE).
