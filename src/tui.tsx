import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"

// Tools whose input points at a single file. Names are matched loosely:
// any tool with "edit"/"write"/"patch" in its name counts as a
// modification, "read" counts as a read. Search tools (glob/grep/shell)
// are ignored so the graph only shows files the agent actually touches.
function classifyTool(name: string): "modified" | "reading" | undefined {
  const n = name.toLowerCase()
  if (n.includes("edit") || n.includes("write") || n.includes("patch")) return "modified"
  if (n === "read" || n.includes("read")) return "reading"
  return undefined
}

// Pull candidate file paths out of a tool input of unknown shape.
// Covers { path }, { filePath }, { file }, { filename }, { files: [] },
// { paths: [] }, and bare-string inputs.
function pathsOf(input: unknown): string[] {
  if (typeof input === "string") {
    const s = input.trim()
    return s && !s.includes("\n") ? [s] : []
  }
  if (!input || typeof input !== "object") return []
  const obj = input as Record<string, unknown>
  const out: string[] = []
  for (const key of ["filePath", "path", "file", "filename", "absolutePath"]) {
    const v = obj[key]
    if (typeof v === "string" && v.trim()) out.push(v.trim())
  }
  for (const key of ["files", "paths"]) {
    const v = obj[key]
    if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === "string" && item.trim()) out.push(item.trim())
        else if (item && typeof item === "object") {
          const p = (item as Record<string, unknown>).path
          if (typeof p === "string" && p.trim()) out.push(p.trim())
        }
      }
    }
  }
  return out
}

interface Entry {
  rel: string
  state: "modified" | "reading"
  active: boolean
}

const MAX_FILES = 8

function GraphPanel(props: { sessionID: string }) {
  const context = usePlugin()
  const [version, setVersion] = createSignal(0)
  const bump = () => setVersion((v) => v + 1)

  const rootDir = createMemo(() => {
    version()
    try {
      const s = context.data.session.get(props.sessionID) as any
      const dir = s?.location?.directory ?? s?.data?.location?.directory
      if (typeof dir === "string" && dir) return dir
    } catch {
      // session may not be cached yet
    }
    try {
      return context.location?.directory ?? ""
    } catch {
      return ""
    }
  })

  const syncOnce = () => {
    try {
      const p = context.data.session.message.sync(props.sessionID) as unknown as Promise<void>
      if (p && typeof p.then === "function") p.then(bump, () => {})
      else bump()
    } catch {
      bump()
    }
  }

  createEffect(() => {
    const sessionID = props.sessionID
    if (!sessionID) return
    syncOnce()
    // Catch-all subscription: the core TUI already keeps the message
    // cache fresh for the visible session, so on any event mentioning
    // this session we just re-derive. A short delayed bump lets the
    // cache settle when the event arrives before the data does.
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = context.data.listen((event) => {
      try {
        if (JSON.stringify(event ?? "").includes(sessionID)) {
          bump()
          if (timer) clearTimeout(timer)
          timer = setTimeout(bump, 300)
        }
      } catch {
        // one bad event must not kill the subscription
      }
    })
    onCleanup(() => {
      stop()
      if (timer) clearTimeout(timer)
    })
  })

  const entries = createMemo<Entry[]>(() => {
    version()
    const sessionID = props.sessionID
    if (!sessionID) return []
    let messages: any[] = []
    try {
      messages = (context.data.session.message.list(sessionID) as any[]) ?? []
    } catch {
      return []
    }
    const root = rootDir()
    const byRel = new Map<string, { state: Entry["state"]; active: boolean; order: number }>()
    let order = 0
    for (const msg of messages) {
      const parts = (msg as any)?.content
      if (!Array.isArray(parts)) continue
      for (const part of parts) {
        if (!part || part.type !== "tool") continue
        const kind = classifyTool(String(part.name ?? part.id ?? ""))
        if (!kind) continue
        const input = part.state?.input ?? part.input
        for (let p of pathsOf(input)) {
          // Skip globs / URLs / shell snippets; only real paths.
          if (p.includes("*") || p.includes("?") || /^[a-z]+:\/\//i.test(p) || p.includes("\n")) continue
          p = p.trim()
          if (!p) continue
          let rel = p
          if (root && p.startsWith(root + "/")) rel = p.slice(root.length + 1)
          else if (root && p === root) continue
          // Outside the project: show basename so the tree stays readable.
          if (rel.startsWith("/")) rel = rel.split("/").pop() ?? rel
          rel = rel.replace(/^\.\//, "")
          if (!rel) continue
          const running = part.state?.status === "running"
          const prev = byRel.get(rel)
          order += 1
          byRel.set(rel, {
            // A file that was ever edited stays green even if read later.
            state: prev?.state === "modified" || kind === "modified" ? "modified" : "reading",
            active: running || (prev?.active === true && kind === "modified"),
            order,
          })
        }
      }
    }
    return [...byRel.entries()]
      .sort((a, b) => b[1].order - a[1].order)
      .slice(0, MAX_FILES)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([rel, v]) => ({ rel, state: v.state, active: v.active }))
  })

  interface Line {
    text: string
    color: string
  }

  const lines = createMemo<Line[]>(() => {
    const list = entries()
    if (list.length === 0) return []
    // Group files under their first path segment, like:
    //   src/
    //   ├─ ● main.rs
    //   └─ ○ lib.rs
    const groups = new Map<string, Entry[]>()
    const topLevel: Entry[] = []
    for (const e of list) {
      const slash = e.rel.indexOf("/")
      if (slash === -1) topLevel.push(e)
      else {
        const dir = e.rel.slice(0, slash) + "/"
        const group = groups.get(dir)
        if (group) group.push(e)
        else groups.set(dir, [e])
      }
    }
    const truncate = (s: string, n: number) =>
      s.length <= n ? s : "…" + s.slice(s.length - n + 1)
    const out: Line[] = []
    const pushFile = (e: Entry, prefix: string, name: string) => {
      const mark = e.active ? "▸" : e.state === "modified" ? "●" : "○"
      const color = e.state === "modified" ? "green" : "gray"
      out.push({ text: `${prefix}${mark} ${truncate(name, 22)}`, color })
    }
    for (const e of topLevel) pushFile(e, "", e.rel)
    for (const [dir, files] of groups) {
      out.push({ text: truncate(dir, 24), color: "white" })
      files.forEach((e, i) => {
        const last = i === files.length - 1
        pushFile(e, last ? "  └─ " : "  ├─ ", e.rel.slice(dir.length))
      })
    }
    return out.slice(0, 12)
  })

  const summary = createMemo(() => {
    const list = entries()
    if (list.length === 0) return ""
    const mod = list.filter((e) => e.state === "modified").length
    const read = list.length - mod
    const bits: string[] = []
    if (mod) bits.push(`${mod} edit`)
    if (read) bits.push(`${read} read`)
    return bits.join(" · ")
  })

  return (
    <box flexDirection="column" borderStyle="rounded" paddingLeft={1} paddingRight={1}>
      <text fg="cyan">{"◉ files · live"}</text>
      <Show when={lines().length > 0} fallback={<text fg="gray">{"no files yet"}</text>}>
        <For each={lines()}>
          {(line) => <text fg={line.color}>{line.text}</text>}
        </For>
      </Show>
      <Show when={summary()}>
        <text fg="gray">{summary()}</text>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "graph-live.cli",
  setup(context) {
    // The red box in the mockup is the right-hand sidebar, i.e. the
    // `sidebar.content` slot. It receives the active sessionID.
    return context.ui.slot({
      append: "sidebar.content",
      render: (input) => {
        const sessionID = (input as { sessionID?: string }).sessionID ?? ""
        return <GraphPanel sessionID={sessionID} />
      },
    })
  },
})
