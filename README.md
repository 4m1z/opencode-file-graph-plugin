# opencode-graph-live

Live file-activity graph for the opencode TUI sidebar. Shows which files
the agent is currently reading (`○`) and modifying (`●`), grouped as a
compact tree — the red box in the mockup, i.e. the `sidebar.content` slot.

```
◉ files · live
cli.json
○ Cargo.toml
○ package.json
src/
  ├─ ○ main.rs
  └─ ○ index.ts
2 edit · 3 read
```

The running tool call's file is marked `▸`. A file that was ever edited
stays green even if it is read again later.

## How it works

- `src/tui.tsx` (CLI half) claims the `sidebar.content` slot and renders
  the graph. It reads tool calls from `data.session.message.list(sessionID)`
  (`read` → reading, `edit`/`write`/`patch` → modified), rebases paths onto
  the session directory, keeps the 8 most recent files, and re-renders on
  every server event mentioning the session (`session.tool.called`,
  `session.tool.success`, `message.content.updated`, … via `data.listen`).
- `src/index.ts` (server half) is a no-op loader so the package also works
  when installed through `plugins` in `opencode.json(c)`, which auto-loads
  the `./tui` entrypoint next to it.

No server hooks, no polling, no extra processes.

## Install

Published-package style (recommended for dev):

```jsonc // opencode.jsonc
{
  "plugins": ["./path/to/opencode-graph-live"]
}
```

or CLI-only (stays active against remote servers):

```jsonc // ~/.config/opencode/cli.json
{
  "plugins": ["/home/amir/Personal/opencode-graph-live"]
}
```

Discovery-dir style (no config edit):

```sh
mkdir -p ~/.config/opencode/plugins/graph-live
cp src/index.ts ~/.config/opencode/plugins/graph-live/index.ts
cp src/tui.tsx ~/.config/opencode/plugins/graph-live/tui.tsx
```

Then restart the TUI (`opencode service restart` if the server caches
plugins) and open a session — the graph appears under the MCP block on
the right sidebar.

## Develop

```sh
bun install
bunx tsc --noEmit
```

`package.json` exposes `.` → `src/index.ts` and `./tui` → `src/tui.tsx`;
`@opentui/*` and `solid-js` are peer dependencies resolved by the host at
runtime. Keep the sidebar render narrow (~24 columns, ≤12 lines): the
`MAX_FILES` constant and the `truncate` helper enforce that.
