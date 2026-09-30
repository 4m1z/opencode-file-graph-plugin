# opencode-graph-live

Live file-activity graph for the opencode TUI sidebar. Shows which files the agent is reading and editing, under the MCP block.

```
● files · live
▸ main.rs ×3 · edit
! lib.rs · 12s
○ index.ts ×2 · 2m
3 files · 2 edits · 1 running
```

- `○` read · `●` edited · `▸` running (with tool name) · `!` failed · `?` awaiting permission
- `×3` is total touches per file, `· 12s` is recency

![sidebar preview](https://github.com/user-attachments/assets/0c9ec4c9-43e8-4228-b7fe-c40eb70f82e1)

## Install

Requires a recent opencode build with TUI plugin support.

**From npm (recommended):**

```sh
opencode plugin add opencode-graph-live@latest
```

```sh
opencode plugin list
opencode plugin check
opencode plugin update opencode-graph-live
opencode plugin remove opencode-graph-live
```

**From git or local checkout:**

```sh
opencode plugin add github:4m1z/opencode-file-graph-plugin
# or pin a ref:
opencode plugin add github:4m1z/opencode-file-graph-plugin#main
```

Or declare it in config (`opencode.json` / `opencode.jsonc`):

```jsonc
{
  "plugins": ["opencode-graph-live@latest"]
  // "plugins": ["opencode-graph-live@0.1.0"]
  // "plugins": ["github:4m1z/opencode-file-graph-plugin"]
  // "plugins": ["./path/to/opencode-file-graph-plugin"] // run `bun run build` first
}
```

Restart the TUI and open a session. The panel shows `no files yet` until the agent touches a file.

## Usage

Ctrl+P commands (all under the `graph-live` group):

| Command | What it does |
| --- | --- |
| Toggle File Graph | Enable/disable the sidebar panel (persisted) |
| File Graph: cycle filter | Cycle `all → edits → reads` |
| File Graph: show edits / reads / all | Filter the list |
| File Graph Detail (`/files`, `/file-graph`) | Full per-file timeline in a session panel (`f` fullscreen, `esc` close) |
| File Graph: show full paths | Picker with touched files → toast reveals the absolute path |

Edit failures also fire a one-time error toast + notification per file.

## How it works

- `src/tui.tsx` renders the `sidebar.content` slot. It derives activity from `data.session.message.list(sessionID)` (`read*` → reading, `edit*`/`write*`/`patch*` → modified) plus `data.session.permission.list()` for `?` pending.
- Paths are rebased onto the session directory, sorted running → error → pending → most-recent, and synced via a debounced `data.listen` subscription (250 ms). No polling, no extra processes.
- A `session.panel` slot (`graph-live.detail`) shows the full per-file timeline (last 5 events per file).
- `src/index.ts` is a no-op server loader so the package also works via `plugins` in `opencode.json(c)`, which auto-loads the `./tui` entrypoint.

Sidebar stays narrow by design: max 8 files, middle-truncated to ~24 cols, single line when empty or disabled.

## Develop

```sh
bun install
bun run typecheck
bun run build
```

Publish:

```sh
bun run build
npm publish --access public
```

`@opentui/*` and `solid-js` are peer dependencies resolved by the host at runtime.

## License

MIT
