# opencode-graph-live

Live file-activity graph for the opencode TUI sidebar. Shows which files the agent is reading and editing, right under the MCP block.

```
● files · live
▸ main.rs ×3 · edit
! lib.rs · 12s
● index.ts ×2 · 2m
3 files · 2 edit · 1 running
```
Legend: ○ read · ● edited · ▸ running (with tool name) · ! failed · ? awaiting permission. Counts (×3) are total touches; · 12s is recency.

preview:
<img width="549" height="466" alt="image" src="https://github.com/user-attachments/assets/0c9ec4c9-43e8-4228-b7fe-c40eb70f82e1" />


## Install

Requires an opencode build with the `sidebar.content` TUI slot and `./tui` plugin entrypoint.

**Option 1 — one command (global, recommended):**

```sh
opencode plugin add opencode-graph-live@latest
```

This installs the npm package and registers it in your global config. Manage it with:

```sh
opencode plugin list
opencode plugin check
opencode plugin update opencode-graph-live
opencode plugin remove opencode-graph-live
```

Before the first npm publish (or to track git directly), any of these also work:

```sh
opencode plugin add github:4m1z/opencode-file-graph-plugin
opencode plugin add github:4m1z/opencode-file-graph-plugin#main
```

**Option 2 — from config (per-project or pinned):**

```jsonc // opencode.json / opencode.jsonc
{
  "plugins": ["opencode-graph-live@latest"]
  // or pin a version:
  // "plugins": ["opencode-graph-live@0.1.0"]
  // or track git:
  // "plugins": ["github:4m1z/opencode-file-graph-plugin"]
  // or a local checkout (run `bun run build` first so `dist/` exists):
  // "plugins": ["./path/to/opencode-file-graph-plugin"]
}
```

Then restart the TUI and open a session. The panel shows `no files yet` until the agent touches a file.

## Commands (Ctrl+P)

| Command | What it does |
|---|---|
| Toggle File Graph | Enable/disable the sidebar panel (persisted) |
| File Graph: cycle filter | `all → edits → reads` |
| File Graph: show edits/reads/all | Filter the list |
| File Graph Detail (`/files`) | Full per-file timeline in a session panel (`f` fullscreen) |
| File Graph: show full paths | Picker with full paths → toast reveals the absolute path |

## How it works

- `src/tui.tsx` renders the `sidebar.content` slot. It derives activity from `data.session.message.list(sessionID)` (`read` → reading, `edit`/`write`/`patch` → modified) plus `data.session.permission.list()` for `? pending`, rebases paths onto the session directory, sorts running → error → pending → most-recent, and syncs via a debounced `data.listen` filter. A `session.panel` contribution (`graph-live.detail`) shows the full per-file timeline; edit failures fire a toast + `attention.notify` once each.
- `src/index.ts` is a no-op server loader so the package also works via `plugins` in `opencode.json(c)`, which auto-loads the `./tui` entrypoint.

No polling, no extra processes. Sidebar stays narrow by design: max 8 files, middle-truncated to ~24 cols, single-line when empty/disabled.

## Develop

```sh
bun install
bun run typecheck
bun run build
```

Publishing a new version:

```sh
bun run build
npm publish --access public
```

`@opentui/*` and `solid-js` are peer dependencies resolved by the host at runtime.
