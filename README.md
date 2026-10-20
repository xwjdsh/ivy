# Ivy

A personal AI agent for the terminal. See [docs/DESIGN.md](docs/DESIGN.md).

```bash
bun install
mkdir -p .ivy && cp -n examples/* .ivy/   # then set api_key in .ivy/config.toml
bun run ivy            # chat; `-c` continues the last session, `-v` shows verbose details
bun test && bun run typecheck && bun run lint
bun run eval           # real-model evals (costs tokens): `bun run eval memory --model <provider>/<model>`
bun run build          # single binary at dist/ivy (prompts are embedded)
bun run build:app      # the menu-bar app at app/build/darwin-arm64/Ivy.app; --install copies it to /Applications
```

In dev, all data (config, `SOUL.md`, sessions, traces, plugin data) lives in `./.ivy/`; delete it to start fresh.

## License

MIT, see [LICENSE](LICENSE).
