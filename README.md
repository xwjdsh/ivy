# Ivy

A personal AI agent for the terminal. See [docs/DESIGN.md](docs/DESIGN.md).

```bash
bun install
mkdir -p .ivy && cp -n examples/* .ivy/   # then set api_key in .ivy/config.toml
bun run ivy            # chat; `-c` continues the last session, `-d` shows debug info
bun test && bun run typecheck && bun run lint
```

In dev, all data (config, `SOUL.md`, `USER.md`, sessions, traces) lives in `./.ivy/`; delete it to start fresh.
