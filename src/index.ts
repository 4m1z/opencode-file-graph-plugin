// Server half of opencode-graph-live.
//
// The sidebar graph itself is rendered by the TUI half (src/tui.tsx),
// which derives file activity from session messages. This server module
// exists so the package loads through `plugins` in opencode.json(c)
// (auto-loads `./tui` alongside it) and to keep a hook point for future
// server-side tracking (e.g. an RPC endpoint).
//
// NOTE: intentionally no `import { Plugin } from "@opencode/plugin"`.
// Plugin.define() is only a type helper; a plain default export with
// `id` + `setup()` loads in V2 without resolver issues (same pattern
// as the stock rtk.ts / tmux-status.ts plugins).

export default {
  id: "graph-live",
  async setup(_ctx: any) {
    // No server hooks needed: file activity is read TUI-side from
    // session messages (tool parts with read/edit/write inputs).
    // Returning undefined = no cleanup.
    return undefined;
  },
};
