import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"

// PanelInput is declared in the installed package's tui/context types but is
// not re-exported from the "@opencode/plugin/tui" entry point, so there is no
// importable PanelInput symbol. The session.panel slot render param carries the
// full panel handle; DetailPanel only needs this structural subset.
type DetailPanelHandle = {
  readonly sessionID: string
  readonly toggleFullscreen: () => void
  readonly close: () => void
}

////////////////////////////// Types //////////////////////////////

type Filter = "all" | "edits" | "reads"
type FileKind = "modified" | "reading"
// Installed tool states are streaming | running | completed | error; pending is
// accepted for forward compatibility (unknown strings are filtered out).
type ToolStatus = "pending" | "running" | "completed" | "error" | "streaming"
type FileStatus = "running" | "error" | "pending" | "done"

type PluginContext = Plugin.Context

type HistoryItem = {
  tool: string
  kind: FileKind
  status: ToolStatus
  at: number
  partID: string
}

type Entry = {
  key: string
  rel: string
  abs: string
  state: FileKind
  status: FileStatus
  tool: string
  reads: number
  writes: number
  order: number
  updatedAt: number
  history: HistoryItem[]
}

type Palette = {
  run: string
  err: string
  mod: string
  dim: string
  head: string
  body: string
}

type Line = {
  text: string
  color: string
}

////////////////////////////// Constants //////////////////////////////

const MAX_FILES = 8
const HISTORY_PER_FILE = 5
const SYNC_DEBOUNCE_MS = 250
const MAX_LINE_WIDTH = 24
const MAX_TOOL_WIDTH = 12
const MAX_PATH_WIDTH = 80
const SETTINGS_KEY = "graph-live.settings"
const CLOCK_MS = 20000
const MAX_NOTIFIED_PER_SESSION = 200

const STATUS_RANK: Record<FileStatus, number> = { running: 0, error: 1, pending: 2, done: 3 }

const READ_TOKENS = new Set(["read", "reads", "reader", "reading"])
const WRITE_TOKENS = new Set(["edit", "edits", "edited", "editing", "write", "writes", "writing", "written", "patch", "patches", "patched", "patching"])

////////////////////////////// Helpers //////////////////////////////

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function thenBump(result: Promise<void> | undefined, bump: () => void, alive: () => boolean): void {
  if (!result) {
    return
  }
  result.then(
    () => {
      if (alive()) {
        bump()
      }
    },
    () => {},
  )
}

function toolNameOf(part: { readonly name: string } & { readonly tool?: unknown }): string {
  const alt = (part as { readonly tool?: unknown }).tool
  if (typeof alt === "string" && alt.trim()) {
    return alt
  }
  return part.name
}

function toolStatusOf(status: string): ToolStatus | undefined {
  if (status === "pending" || status === "running" || status === "completed" || status === "error" || status === "streaming") {
    return status
  }
  return undefined
}

/** Best activity timestamp for a tool part. Prefers state.time (newer APIs),
 *  falls back to the installed top-level part.time. */
function partActivityTime(part: {
  readonly state: unknown
  readonly time: { readonly created: number; readonly ran?: number; readonly completed?: number }
}): number {
  const st = isRecord(part.state) ? part.state.time : undefined
  if (isRecord(st)) {
    if (typeof st.end === "number" && st.end > 0) {
      return st.end
    }
    if (typeof st.start === "number" && st.start > 0) {
      return st.start
    }
  }
  return part.time.completed ?? part.time.ran ?? part.time.created ?? 0
}

function tokenizeToolName(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0)
}

function classifyTool(name: string): FileKind | undefined {
  const tokens = new Set(tokenizeToolName(name))
  for (const t of WRITE_TOKENS) {
    if (tokens.has(t)) {
      return "modified"
    }
  }
  for (const t of READ_TOKENS) {
    if (tokens.has(t)) {
      return "reading"
    }
  }
  return undefined
}

function pushPath(out: string[], value: unknown): void {
  if (typeof value === "string" && value.trim()) {
    out.push(value.trim())
  }
}

function pathsOf(input: unknown): string[] {
  if (typeof input === "string") {
    const s = input.trim()
    return s && !s.includes("\n") ? [s] : []
  }
  if (!isRecord(input)) {
    return []
  }
  const out: string[] = []
  for (const key of ["filePath", "path", "file", "filename", "absolutePath"]) {
    pushPath(out, input[key])
  }
  for (const key of ["files", "paths"]) {
    const v = input[key]
    if (!Array.isArray(v)) {
      continue
    }
    for (const item of v) {
      if (typeof item === "string") {
        pushPath(out, item)
      } else if (isRecord(item)) {
        pushPath(out, item.path)
      }
    }
  }
  return out
}

function truncateMiddle(s: string, n: number): string {
  if (s.length <= n) {
    return s
  }
  if (n <= 2) {
    return s.slice(0, n)
  }
  const head = Math.ceil((n - 1) / 2)
  const tail = Math.floor((n - 1) / 2)
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`
}

function timeAgo(at: number, now: number): string {
  if (!at) {
    return ""
  }
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 5) {
    return "now"
  }
  if (s < 60) {
    return `${s}s`
  }
  const m = Math.floor(s / 60)
  if (m < 60) {
    return `${m}m`
  }
  return `${Math.floor(m / 60)}h`
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function themeColor(ctx: PluginContext, path: string[], fallback: string): string {
  let cur: unknown = ctx.theme
  for (const p of path) {
    if (!isRecord(cur)) {
      return fallback
    }
    cur = cur[p]
  }
  if (typeof cur === "string" && cur) {
    return cur
  }
  return fallback
}

function resolvePalette(ctx: PluginContext): Palette {
  return {
    run: themeColor(ctx, ["warning", "base"], "yellow"),
    err: themeColor(ctx, ["error", "base"], "red"),
    mod: themeColor(ctx, ["success", "base"], "green"),
    dim: themeColor(ctx, ["text", "muted"], "gray"),
    head: themeColor(ctx, ["text", "accent"], "cyan"),
    body: themeColor(ctx, ["text", "base"], "white"),
  }
}

function isBusyStatus(status: unknown): boolean {
  if (typeof status === "string") {
    return status === "running"
  }
  if (isRecord(status)) {
    return status.type === "busy" || status.type === "retry"
  }
  return false
}

function statusMark(e: Pick<Entry, "state" | "status">): string {
  if (e.status === "running") {
    return "▸"
  }
  if (e.status === "error") {
    return "!"
  }
  if (e.status === "pending") {
    return "?"
  }
  return e.state === "modified" ? "●" : "○"
}

function statusColor(e: Pick<Entry, "state" | "status">, p: Palette): string {
  if (e.status === "running" || e.status === "pending") {
    return p.run
  }
  if (e.status === "error") {
    return p.err
  }
  return e.state === "modified" ? p.mod : p.dim
}

function toLine(e: Entry, p: Palette, now: number): Line {
  const touches = e.reads + e.writes
  const count = touches > 1 ? ` ×${touches}` : ""
  const extra =
    e.status === "running"
      ? ` · ${truncateMiddle(e.tool, MAX_TOOL_WIDTH)}`
      : e.updatedAt
        ? ` · ${timeAgo(e.updatedAt, now)}`
        : ""
  return { text: `${statusMark(e)} ${truncateMiddle(e.rel, MAX_LINE_WIDTH)}${count}${extra}`, color: statusColor(e, p) }
}

function toSummary(list: Entry[], filter: Filter): string {
  if (list.length === 0) {
    return ""
  }
  const mod = list.filter((e) => e.state === "modified").length
  const run = list.filter((e) => e.status === "running").length
  const err = list.filter((e) => e.status === "error").length
  const bits = [plural(list.length, "file", "files")]
  if (mod) {
    bits.push(plural(mod, "edit", "edits"))
  }
  if (run) {
    bits.push(plural(run, "running", "running"))
  }
  if (err) {
    bits.push(plural(err, "failed", "failed"))
  }
  if (filter !== "all") {
    bits.push(filter)
  }
  return bits.join(" · ")
}

////////////////////////////// Paths //////////////////////////////

function isRealPath(p: string): boolean {
  return !p.includes("*") && !p.includes("?") && !/^[a-z]+:\/\//i.test(p) && !p.includes("\n") && p.trim() !== ""
}

function splitDrive(path: string): { prefix: string; rest: string } {
  const m = /^([a-zA-Z]:)(\/|$)/.exec(path)
  if (m) {
    return { prefix: m[1], rest: path.slice(m[1].length) }
  }
  return { prefix: "", rest: path }
}

function normalizeKey(value: string): string {
  let p = value.replace(/\\/g, "/").trim()
  const { prefix, rest } = splitDrive(p)
  const absolute = rest.startsWith("/")
  const parts = rest.split("/")
  const stack: string[] = []
  for (const seg of parts) {
    if (seg === "" || seg === ".") {
      continue
    }
    if (seg === "..") {
      if (stack.length > 0) {
        stack.pop()
      }
      continue
    }
    stack.push(seg)
  }
  const joined = stack.join("/")
  if (prefix) {
    return `${prefix.toUpperCase()}/${joined}`
  }
  return absolute ? `/${joined}` : joined
}

function normalizeRoot(root: string): string {
  if (!root) {
    return ""
  }
  const key = normalizeKey(root)
  return key.endsWith("/") && key.length > 1 ? key.slice(0, -1) : key
}

/** Canonical absolute key + display path. Returns undefined for non-paths.
 *  Display is project-relative only when below root; otherwise the full
 *  canonical absolute path (never bare basename). */
function toKeyAndDisplay(raw: string, rootNorm: string): { key: string; rel: string; abs: string } | undefined {
  const trimmed = raw.trim()
  if (!isRealPath(trimmed)) {
    return undefined
  }
  const withSlashes = trimmed.replace(/\\/g, "/")
  const hasDrive = /^[a-zA-Z]:(\/|$)/.test(withSlashes)
  const isAbs = withSlashes.startsWith("/") || hasDrive
  const absLike = isAbs ? normalizeKey(withSlashes) : rootNorm ? normalizeKey(`${rootNorm}/${withSlashes.replace(/^\.\//, "")}`) : normalizeKey(withSlashes)
  if (!absLike || absLike === rootNorm) {
    return undefined
  }
  let rel = absLike
  if (rootNorm && (absLike === rootNorm || absLike.startsWith(`${rootNorm}/`))) {
    rel = absLike.slice(rootNorm.length + 1).replace(/^\.\//, "")
  }
  if (!rel) {
    return undefined
  }
  return { key: absLike, rel, abs: absLike }
}

////////////////////////////// Derivation //////////////////////////////

function resolveRoot(ctx: PluginContext, sessionID: string): string {
  const viaRoot = ctx.data.session.root(sessionID)
  if (viaRoot) {
    return normalizeRoot(viaRoot)
  }
  const session = ctx.data.session.get(sessionID)
  if (session?.location?.directory) {
    return normalizeRoot(session.location.directory)
  }
  return normalizeRoot(ctx.location?.directory ?? "")
}

function pendingKeys(ctx: PluginContext, sessionID: string, rootNorm: string): Set<string> {
  const out = new Set<string>()
  const reqs = ctx.data.session.permission.list(sessionID)
  if (!reqs) {
    return out
  }
  for (const r of reqs) {
    for (const res of r.resources) {
      const trimmed = res.trim()
      if (!isRealPath(trimmed)) {
        continue
      }
      const withSlashes = trimmed.replace(/\\/g, "/")
      const hasDrive = /^[a-zA-Z]:(\/|$)/.test(withSlashes)
      const isAbs = withSlashes.startsWith("/") || hasDrive
      out.add(isAbs ? normalizeKey(withSlashes) : rootNorm ? normalizeKey(`${rootNorm}/${withSlashes.replace(/^\.\//, "")}`) : normalizeKey(withSlashes))
    }
  }
  return out
}

function deriveEntries(ctx: PluginContext, sessionID: string): Entry[] {
  if (!sessionID) {
    return []
  }
  const messages = ctx.data.session.message.list(sessionID)
  if (!messages || messages.length === 0) {
    return []
  }
  const root = resolveRoot(ctx, sessionID)
  const pending = pendingKeys(ctx, sessionID, root)

  const byKey = new Map<string, Entry>()
  let order = 0
  for (const msg of messages) {
    if (msg.type !== "assistant") {
      continue
    }
    for (const part of msg.content) {
      if (part.type !== "tool") {
        continue
      }
      const toolName = toolNameOf(part)
      const kind = classifyTool(toolName)
      if (!kind) {
        continue
      }
      const status = toolStatusOf(part.state.status)
      if (!status) {
        continue
      }
      const at = partActivityTime(part)
      const seen = new Set<string>()
      for (const raw of pathsOf(part.state.input)) {
        const mapped = toKeyAndDisplay(raw, root)
        if (!mapped || seen.has(mapped.key)) {
          continue
        }
        seen.add(mapped.key)
        order += 1
        const prev = byKey.get(mapped.key)
        const history = [...(prev?.history ?? []), { tool: toolName, kind, status, at, partID: part.id }].slice(-HISTORY_PER_FILE)
        byKey.set(mapped.key, {
          key: mapped.key,
          rel: mapped.rel,
          abs: mapped.abs,
          state: prev?.state === "modified" || kind === "modified" ? "modified" : "reading",
          status: "done",
          tool: toolName,
          reads: (prev?.reads ?? 0) + (kind === "reading" ? 1 : 0),
          writes: (prev?.writes ?? 0) + (kind === "modified" ? 1 : 0),
          order,
          updatedAt: at || prev?.updatedAt || 0,
          history,
        })
      }
    }
  }

  for (const e of byKey.values()) {
    const last = e.history[e.history.length - 1]
    if (last?.status === "running" || last?.status === "streaming") {
      e.status = "running"
    } else if (last?.status === "pending") {
      e.status = "pending"
    } else if (last?.status === "error") {
      e.status = "error"
    } else if (pending.has(e.key)) {
      e.status = "pending"
    } else {
      e.status = "done"
    }
  }
  return [...byKey.values()].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.order - a.order)
}

////////////////////////////// Live sync //////////////////////////////

const notifiedErrors = new Map<string, Set<string>>()

function activeSessionID(ctx: PluginContext): string {
  const route = ctx.ui.router.current()
  if (route.type === "session") {
    return route.sessionID
  }
  return ctx.ui.tabs.list()?.find((t) => t.active)?.sessionID ?? ""
}

function extractEventSessionID(details: unknown): string | undefined {
  if (!isRecord(details)) {
    return undefined
  }
  const data = details.data
  if (isRecord(data) && typeof data.sessionID === "string") {
    return data.sessionID
  }
  const props = details.properties
  if (isRecord(props)) {
    if (typeof props.sessionID === "string") {
      return props.sessionID
    }
    const part = props.part
    if (isRecord(part) && typeof part.sessionID === "string") {
      return part.sessionID
    }
  }
  return undefined
}

type SyncKind = "message" | "permission" | "both" | "bump"

function classifyEvent(details: unknown): SyncKind {
  if (!isRecord(details)) {
    return "bump"
  }
  const type = details.type
  if (typeof type !== "string") {
    return "bump"
  }
  if (type === "permission.asked" || type === "permission.replied") {
    return "permission"
  }
  if (
    type.startsWith("session.tool.") ||
    type.startsWith("session.message.") ||
    type.startsWith("session.execution.") ||
    type.startsWith("session.step.") ||
    type.startsWith("session.text.") ||
    type.startsWith("session.reasoning.") ||
    type === "session.retry.scheduled" ||
    type === "session.compaction.ended" ||
    type === "session.status" ||
    type === "session.idle"
  ) {
    return "message"
  }
  if (type.startsWith("session.")) {
    return "message"
  }
  return "bump"
}

function useSessionVersion(ctx: PluginContext, sessionID: () => string): () => number {
  const [version, setVersion] = createSignal(0)
  const bump = () => setVersion((v) => v + 1)

  createEffect(() => {
    const sid = sessionID()
    if (!sid) {
      return
    }
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let pendingKind: SyncKind = "both"
    const isAlive = () => alive

    thenBump(ctx.data.session.message.sync(sid), bump, isAlive)
    thenBump(ctx.data.session.permission.sync(sid), bump, isAlive)

    const flush = () => {
      timer = undefined
      if (!alive) {
        return
      }
      const kind = pendingKind
      pendingKind = "both"
      if (kind === "message" || kind === "both") {
        thenBump(ctx.data.session.message.sync(sid), bump, isAlive)
      }
      if (kind === "permission" || kind === "both") {
        thenBump(ctx.data.session.permission.sync(sid), bump, isAlive)
      }
    }
    const schedule = (kind: SyncKind) => {
      if (kind === "both") {
        pendingKind = "both"
      } else if (pendingKind !== "both" && pendingKind !== kind && (kind === "message" || kind === "permission")) {
        pendingKind = "both"
      } else if (pendingKind === "bump") {
        pendingKind = kind
      }
      if (timer) {
        clearTimeout(timer)
      }
      timer = setTimeout(flush, SYNC_DEBOUNCE_MS)
    }

    const stop = ctx.data.listen((event) => {
      if (!alive) {
        return
      }
      const details = event?.details
      if (extractEventSessionID(details) !== sid) {
        return
      }
      bump()
      schedule(classifyEvent(details))
    })
    onCleanup(() => {
      alive = false
      stop()
      if (timer) {
        clearTimeout(timer)
      }
    })
  })

  return version
}

function useNow(intervalMs: number): () => number {
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), intervalMs)
  onCleanup(() => clearInterval(timer))
  return now
}

function notifyFailures(ctx: PluginContext, sessionID: string, list: Entry[]): void {
  if (!sessionID) {
    return
  }
  let seen = notifiedErrors.get(sessionID)
  if (!seen) {
    seen = new Set<string>()
    notifiedErrors.set(sessionID, seen)
  }
  for (const e of list) {
    if (e.status !== "error" || e.state !== "modified") {
      continue
    }
    const lastError = [...e.history].reverse().find((h) => h.status === "error")
    const partID = lastError?.partID || `${e.order}`
    if (seen.has(partID)) {
      continue
    }
    seen.add(partID)
    while (seen.size > MAX_NOTIFIED_PER_SESSION) {
      const oldest = seen.values().next()
      if (oldest.done || oldest.value === undefined) {
        break
      }
      seen.delete(oldest.value)
    }
    ctx.ui.toast.show({
      title: "File edit failed",
      message: `${e.rel} (${e.tool})`,
      variant: "error",
      sessionID,
    })
    void ctx.attention
      .notify({
        title: "Edit failed",
        message: e.rel,
        notification: { when: "blurred" },
        sound: { name: "error", when: "always" },
      })
      .catch(() => {})
  }
  if (notifiedErrors.size > 20) {
    const first = notifiedErrors.keys().next()
    if (!first.done && first.value !== undefined && first.value !== sessionID) {
      notifiedErrors.delete(first.value)
    }
  }
}

////////////////////////////// Components //////////////////////////////

function GraphPanel(props: { sessionID: string; enabled: boolean; filter: Filter }) {
  const ctx = usePlugin()
  const palette = createMemo<Palette>(() => resolvePalette(ctx))
  const version = useSessionVersion(ctx, () => props.sessionID)
  const now = useNow(CLOCK_MS)

  const all = createMemo<Entry[]>(() => {
    version()
    return deriveEntries(ctx, props.sessionID)
  })
  const entries = createMemo(() => {
    const list = all()
    if (props.filter === "edits") {
      return list.filter((e) => e.writes > 0)
    }
    if (props.filter === "reads") {
      return list.filter((e) => e.reads > 0)
    }
    return list
  })
  const busy = createMemo(() => {
    version()
    if (!props.sessionID) {
      return false
    }
    return isBusyStatus(ctx.data.session.status(props.sessionID))
  })
  const lines = createMemo<Line[]>(() => entries().slice(0, MAX_FILES).map((e) => toLine(e, palette(), now())))
  const summary = createMemo(() => toSummary(entries(), props.filter))
  const header = createMemo(() => {
    const badge = props.filter === "all" ? "live" : `live · ${props.filter}`
    return `${busy() ? "●" : "◉"} files · ${badge}`
  })

  createEffect(() => notifyFailures(ctx, props.sessionID, all()))

  return (
    <Show when={props.enabled} fallback={<text fg={palette().dim}>{"files · off — Ctrl+P → Toggle File Graph"}</text>}>
      <box flexDirection="column" borderStyle="rounded" paddingLeft={1} paddingRight={1}>
        <text fg={palette().head}>{header()}</text>
        <Show when={lines().length > 0} fallback={<text fg={palette().dim}>{"no files yet — reads/edits appear here"}</text>}>
          <For each={lines()}>{(line) => <text fg={line.color}>{line.text}</text>}</For>
        </Show>
        <Show when={summary()}>
          <text fg={palette().dim}>{summary()}</text>
        </Show>
        <Show when={entries().length > MAX_FILES}>
          <text fg={palette().dim}>{`+${entries().length - MAX_FILES} more — Ctrl+P → File Graph Detail`}</text>
        </Show>
      </box>
    </Show>
  )
}

function DetailPanel(props: { panel: DetailPanelHandle }) {
  const ctx = usePlugin()
  const palette = createMemo<Palette>(() => resolvePalette(ctx))
  const getID = () => props.panel.sessionID ?? ""
  const version = useSessionVersion(ctx, getID)
  const now = useNow(CLOCK_MS)

  ctx.keymap.layer(() => ({
    commands: [
      {
        id: "graph-live.detail.fullscreen",
        title: "File Graph: toggle fullscreen",
        bind: "f",
        run: () => {
          props.panel.toggleFullscreen()
        },
      },
      {
        id: "graph-live.detail.close",
        title: "File Graph: close detail",
        bind: "escape",
        run: () => {
          props.panel.close()
        },
      },
    ],
  }))

  const entries = createMemo<Entry[]>(() => {
    version()
    return deriveEntries(ctx, getID())
  })

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <text fg={palette().body}>{`file activity · ${entries().length} file(s) · f fullscreen · esc close`}</text>
      <Show when={entries().length > 0} fallback={<text fg={palette().dim}>{"no file reads/edits in this session yet"}</text>}>
        <For each={entries()}>
          {(e) => (
            <box flexDirection="column" paddingTop={1}>
              <text fg={statusColor(e, palette())}>{`${statusMark(e)} ${e.rel} · r${e.reads} w${e.writes}`}</text>
              <text fg={palette().dim}>{truncateMiddle(e.abs, MAX_PATH_WIDTH)}</text>
              <For each={e.history.slice(-HISTORY_PER_FILE).reverse()}>
                {(h) => (
                  <text fg={h.status === "error" ? palette().err : palette().dim}>
                    {`  ${h.status === "error" ? "!" : h.status === "running" || h.status === "streaming" || h.status === "pending" ? "▸" : "·"} ${truncateMiddle(h.tool, 20)} ${h.kind === "modified" ? "edit" : "read"} · ${h.status} · ${timeAgo(h.at, now())}`}
                  </text>
                )}
              </For>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}

////////////////////////////// Plugin setup //////////////////////////////

export default Plugin.define({
  id: "graph-live.cli",
  setup(context) {
    const ctx = context
    const [store, setStore] = ctx.storage.store<{ enabled: boolean; filter: Filter }>(SETTINGS_KEY, { initial: { enabled: true, filter: "all" } })

    const setFilter = (filter: Filter) => {
      void setStore((draft) => {
        draft.filter = filter
      })
    }
    const toggle = () => {
      void setStore((draft) => {
        draft.enabled = !draft.enabled
      })
    }
    const cycleFilter = () => {
      const next: Filter = store.filter === "all" ? "edits" : store.filter === "edits" ? "reads" : "all"
      setFilter(next)
      ctx.ui.toast.show({ message: `file graph: ${next}`, variant: "info" })
    }
    const openDetail = () => {
      const ok = ctx.ui.panel.open("graph-live.detail")
      if (!ok) {
        ctx.ui.toast.show({ message: "open a session first", variant: "warning" })
      }
    }
    const showPaths = async () => {
      const sid = activeSessionID(ctx)
      if (!sid) {
        ctx.ui.toast.show({ message: "open a session first", variant: "warning" })
        return
      }
      const list = deriveEntries(ctx, sid)
      if (list.length === 0) {
        ctx.ui.toast.show({ message: "no files yet", variant: "info" })
        return
      }
      const picked = await ctx.ui.dialog.select({
        title: "Touched files",
        options: list.map((e) => ({
          title: e.rel,
          value: e.abs,
          description: `${e.state === "modified" ? "edit" : "read"} · r${e.reads} w${e.writes} · ${e.status}`,
          footer: e.abs,
        })),
      })
      if (picked) {
        ctx.ui.toast.show({ message: String(picked), variant: "info", sessionID: sid })
      }
    }

    const stopCommands = ctx.ui.slot({
      append: "app",
      render: () => {
        ctx.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "graph-live.toggle",
              title: "Toggle File Graph",
              description: "Enable or disable the live file activity graph in the sidebar",
              group: "graph-live",
              palette: true,
              run: toggle,
            },
            {
              id: "graph-live.filter.cycle",
              title: "File Graph: cycle filter (all → edits → reads)",
              group: "graph-live",
              palette: true,
              run: cycleFilter,
            },
            {
              id: "graph-live.filter.edits",
              title: "File Graph: show edits only",
              group: "graph-live",
              palette: true,
              run: () => setFilter("edits"),
            },
            {
              id: "graph-live.filter.reads",
              title: "File Graph: show reads only",
              group: "graph-live",
              palette: true,
              run: () => setFilter("reads"),
            },
            {
              id: "graph-live.filter.all",
              title: "File Graph: show all files",
              group: "graph-live",
              palette: true,
              run: () => setFilter("all"),
            },
            {
              id: "graph-live.detail",
              title: "File Graph Detail",
              description: "Open the full per-file timeline in a session panel",
              group: "graph-live",
              palette: true,
              slash: { name: "files", aliases: ["file-graph"] },
              run: openDetail,
            },
            {
              id: "graph-live.paths",
              title: "File Graph: show full paths",
              description: "Pick a touched file to reveal its full path",
              group: "graph-live",
              palette: true,
              run: showPaths,
            },
          ],
        }))
        return null
      },
    })

    const stopDetail = ctx.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === "graph-live.detail"}>
          <DetailPanel panel={panel} />
        </Show>
      ),
    })

    const stopPanel = ctx.ui.slot({
      append: "sidebar.content",
      render: (input) => {
        const sessionID = input.sessionID ?? ""
        return <GraphPanel sessionID={sessionID} enabled={store.enabled} filter={store.filter} />
      },
    })

    return () => {
      stopCommands()
      stopDetail()
      stopPanel()
    }
  },
})
