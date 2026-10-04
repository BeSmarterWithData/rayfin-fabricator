import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type { StudioProject, TeamMap, TeamMapApp, TeamMapCopy, TeamMapRun, TeamWorkspace } from '@shared/ipc'
import { useSuppressPreview } from '../../../overlay'
import { Codicon } from '../../icons'
import { teamError } from '../common'
import { timeAgo, useNow } from '../runProgress'
import ActivityPanel from './ActivityPanel'
import { DataPanel, ResourceDetails } from './DataPanels'
import { EmptyNodeBody, ResourceNodeBody, SourceNodeBody, sourceApps } from './DataNodes'
import Inspector from './Inspector'
import WorkspacePanel from './WorkspacePanel'
import {
  appHealth,
  copyHealth,
  isActive,
  layoutData,
  layoutMap,
  lineage,
  mapStats,
  nodeIds,
  previewBehind,
  previewing,
  publishedHealth,
  publishing,
  type Health,
  type MapLayout,
  type MapNode
} from './model'
import { Avatar, DiffBar, FabricGlyph, HealthPill, RunLine, changeTitle, host, hueOf } from './parts'
import { buildResourceView, dataStats, parseSources, resourceRequests, type ResourceView } from './resources'
import './teamMap.css'

/** What the overview shows beside the apps: everyone's changes, or each app's data and connections. */
export type Lens = 'changes' | 'data'

interface Props {
  workspace: TeamWorkspace
  /** Bring this app into view when the overview opens. */
  focusFolder?: string
  /** Open with the workspace's members and settings showing. */
  manage?: boolean
  /** Start on this view (default: changes). */
  initialLens?: Lens
  onClose: () => void
  /** A team app was opened from the overview. */
  onOpened: (project: StudioProject) => void
  onNewApp?: (workspaceId: string) => void
  /** Members, settings or apps changed, or the workspace was left: refresh. */
  onChanged?: () => void
  /** Test seam: start from this data instead of asking GitHub. */
  initialMap?: TeamMap
}

interface View {
  scale: number
  tx: number
  ty: number
}

const PAD = 56
const MIN_SCALE = 0.25
const MAX_SCALE = 1.8
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** The workspace overview: apps, working copies, previews, published apps and the pipeline, as a tree. */
export default function TeamMapView({
  workspace,
  focusFolder,
  manage,
  initialLens = 'changes',
  onClose,
  onOpened,
  onNewApp,
  onChanged,
  initialMap
}: Props): JSX.Element {
  useSuppressPreview()
  const [map, setMap] = useState<TeamMap | null>(initialMap ?? null)
  const [runs, setRuns] = useState<TeamMapRun[]>(initialMap?.runs ?? [])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(initialMap?.error ?? null)
  const [lens, setLens] = useState<Lens>(initialLens)
  const [dataView, setDataView] = useState<ResourceView | null>(null)
  const [dataLoading, setDataLoading] = useState(false)
  const [dataError, setDataError] = useState<string | null>(null)
  const [selection, setSelection] = useState<string | null>(manage ? nodeIds.hub : null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [heights, setHeights] = useState<Record<string, number>>({})
  const [view, setView] = useState<View>({ scale: 0.85, tx: 32, ty: 24 })
  const [panning, setPanning] = useState(false)
  const viewportRef = useRef<HTMLDivElement>(null)
  const nodeRefs = useRef(new Map<string, HTMLDivElement>())
  const viewRef = useRef(view)
  viewRef.current = view
  const runsRef = useRef(runs)
  runsRef.current = runs
  const aliveRef = useRef(true)
  const fitPending = useRef(true)
  const gesture = useRef<{ startX: number; startY: number; tx0: number; ty0: number } | null>(null)
  const now = useNow(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const next = await window.api.team.map(workspace.id)
      if (!aliveRef.current) return
      setMap(next)
      setRuns(next.runs)
      setError(next.error ?? null)
    } catch (reason) {
      if (aliveRef.current) setError(teamError(reason, 'Could not load the workspace.'))
    } finally {
      if (aliveRef.current) setLoading(false)
    }
  }, [workspace.id])

  useEffect(() => {
    if (!initialMap) void load()
  }, [initialMap, load])

  // Follow the pipeline: quickly while something deploys, slowly otherwise. A
  // run starting or finishing means copies or deployments changed: reload.
  const ready = map !== null
  useEffect(() => {
    if (!ready || initialMap) return
    let timer: number | undefined
    let stopped = false
    const schedule = (): void => {
      if (stopped) return
      timer = window.setTimeout(() => void tick(), runsRef.current.some(isActive) ? 4_000 : 15_000)
    }
    const tick = async (): Promise<void> => {
      if (!document.hidden) {
        try {
          const activity = await window.api.team.activity(workspace.id)
          if (stopped) return
          if (activity.ok) {
            const before = runsRef.current.filter(isActive).map((r) => r.id)
            const finished = before.some((id) => !activity.runs.some((r) => r.id === id && isActive(r)))
            const started = activity.runs.some((r) => isActive(r) && !before.includes(r.id))
            setRuns(activity.runs)
            if (finished || started) void load()
          }
        } catch {
          /* keep showing what we have */
        }
      }
      schedule()
    }
    schedule()
    const full = window.setInterval(() => {
      if (!document.hidden) void load()
    }, 60_000)
    return () => {
      stopped = true
      window.clearTimeout(timer)
      window.clearInterval(full)
    }
  }, [ready, initialMap, workspace.id, load])

  // The data view reads each app's config (published, and the working copies
  // that change it) whenever the workspace is read again.
  const dataSeq = useRef(0)
  const dataViewRef = useRef(dataView)
  dataViewRef.current = dataView
  useEffect(() => {
    if (lens !== 'data' || !map) return
    const seq = ++dataSeq.current
    setDataLoading(true)
    void (async () => {
      try {
        const requests = resourceRequests(map)
        const result = requests.length
          ? await window.api.team.resources(workspace.id, requests)
          : { ok: true, error: undefined, sources: [] }
        const parsed = await parseSources(result.sources)
        if (!aliveRef.current || seq !== dataSeq.current) return
        // The first answer changes the layout's size: fit it to the window again.
        if (!dataViewRef.current) fitPending.current = true
        setDataView(buildResourceView(map, parsed))
        setDataError(result.ok ? null : (result.error ?? 'Could not read the apps.'))
      } catch (reason) {
        if (aliveRef.current && seq === dataSeq.current) setDataError(teamError(reason, 'Could not read the apps.'))
      } finally {
        if (aliveRef.current && seq === dataSeq.current) setDataLoading(false)
      }
    })()
  }, [lens, map, workspace.id])

  const layout: MapLayout | null = useMemo(
    () => (map ? (lens === 'data' ? layoutData(map, dataView, heights) : layoutMap(map, runs, heights)) : null),
    [map, runs, heights, lens, dataView]
  )
  const stats = useMemo(() => (map ? mapStats(map, runs) : null), [map, runs])
  const data = useMemo(() => dataStats(dataView), [dataView])
  const itemById = useMemo(
    () => new Map(Object.values(dataView?.apps ?? {}).flatMap((a) => a.items).map((i) => [i.id, i])),
    [dataView]
  )
  const sourceById = useMemo(() => new Map((dataView?.sources ?? []).map((s) => [s.id, s])), [dataView])

  /** Switch views, keeping what's selected when it's in both. */
  const switchLens = (next: Lens): void => {
    if (next === lens) return
    setLens(next)
    setHovered(null)
    setSelection((s) => (s === nodeIds.hub || s?.startsWith('app:') ? s : null))
    fitPending.current = true
  }
  const focusSet = useMemo(() => {
    const id = hovered ?? selection
    return layout && id ? lineage(layout, id) : null
  }, [layout, hovered, selection])

  const fitTo = useCallback(
    (ids?: Set<string>): void => {
      const vp = viewportRef.current
      if (!vp || !layout) return
      const nodes = layout.nodes.filter((n) => !ids || ids.has(n.id))
      if (!nodes.length || vp.clientWidth === 0) return
      const minX = Math.min(...nodes.map((n) => n.x)) + PAD
      const minY = (ids ? Math.min(...nodes.map((n) => n.y)) : 0) + PAD
      const maxX = Math.max(...nodes.map((n) => n.x + n.w)) + PAD
      const maxY = Math.max(...nodes.map((n) => n.y + n.h)) + PAD
      const margin = 40
      const scale = clamp(
        Math.min((vp.clientWidth - margin * 2) / (maxX - minX), (vp.clientHeight - margin * 2) / (maxY - minY), 1),
        MIN_SCALE,
        MAX_SCALE
      )
      setView({
        scale,
        tx: vp.clientWidth / 2 - ((minX + maxX) / 2) * scale,
        ty: vp.clientHeight / 2 - ((minY + maxY) / 2) * scale
      })
    },
    [layout]
  )

  // Measure the rendered nodes; lay out again when they're taller or shorter
  // than assumed, then (once) fit the map to the window.
  useLayoutEffect(() => {
    if (!layout) return
    const measured: Record<string, number> = {}
    let changed = false
    nodeRefs.current.forEach((el, id) => {
      measured[id] = el.offsetHeight
      if (Math.abs((heights[id] ?? -1) - el.offsetHeight) > 1) changed = true
    })
    if (changed) {
      setHeights(measured)
      return
    }
    if (fitPending.current) {
      fitPending.current = false
      const app = focusFolder ? map?.apps.find((a) => a.folder.toLowerCase() === focusFolder.toLowerCase()) : undefined
      fitTo(app ? lineage(layout, nodeIds.app(app.folder)) : undefined)
    }
  }, [layout, heights, fitTo, focusFolder, map])

  // Cursor-anchored zoom on the wheel (non-passive so the page doesn't scroll).
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = vp.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const v = viewRef.current
      const scale = clamp(v.scale * Math.exp(-e.deltaY * 0.0015), MIN_SCALE, MAX_SCALE)
      const k = scale / v.scale
      setView({ scale, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k })
    }
    vp.addEventListener('wheel', onWheel, { passive: false })
    return () => vp.removeEventListener('wheel', onWheel)
  }, [ready])

  const zoomBy = useCallback((k: number): void => {
    const vp = viewportRef.current
    if (!vp) return
    const cx = vp.clientWidth / 2
    const cy = vp.clientHeight / 2
    const v = viewRef.current
    const scale = clamp(v.scale * k, MIN_SCALE, MAX_SCALE)
    const kk = scale / v.scale
    setView({ scale, tx: cx - (cx - v.tx) * kk, ty: cy - (cy - v.ty) * kk })
  }, [])

  // Esc closes the details first, then the overview. Capture runs this before a
  // dialog's own Esc handler can remove it, so a dialog on top keeps its Esc.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('.modal-backdrop')) return
      if (selection) setSelection(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [selection, onClose])

  const onBackgroundDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    const v = viewRef.current
    gesture.current = { startX: e.clientX, startY: e.clientY, tx0: v.tx, ty0: v.ty }
    viewportRef.current?.setPointerCapture?.(e.pointerId)
    setPanning(true)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = gesture.current
    if (!g) return
    setView((v) => ({ ...v, tx: g.tx0 + (e.clientX - g.startX), ty: g.ty0 + (e.clientY - g.startY) }))
  }
  const endPan = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = gesture.current
    gesture.current = null
    setPanning(false)
    try {
      viewportRef.current?.releasePointerCapture?.(e.pointerId)
    } catch {
      /* already released */
    }
    // A click on empty space (not a drag) clears the selection.
    if (g && Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < 4) setSelection(null)
  }

  const openApp = useCallback(
    async (folder: string): Promise<void> => {
      setOpening(folder)
      setError(null)
      try {
        const result = await window.api.team.openProject(workspace.id, folder)
        if (!aliveRef.current) return
        if (result.ok && result.project) onOpened(result.project)
        else setError(result.error ?? 'Could not open the app.')
      } catch (reason) {
        if (aliveRef.current) setError(teamError(reason, 'Could not open the app.'))
      } finally {
        if (aliveRef.current) setOpening(null)
      }
    },
    [workspace.id, onOpened]
  )

  /** Select a node and bring it into view. */
  const reveal = useCallback(
    (id: string): void => {
      setSelection(id)
      const node = layout?.nodes.find((n) => n.id === id)
      const vp = viewportRef.current
      if (!node || !vp) return
      const v = viewRef.current
      const cx = (node.x + PAD + node.w / 2) * v.scale + v.tx
      const cy = (node.y + PAD + node.h / 2) * v.scale + v.ty
      if (cx < 80 || cx > vp.clientWidth - 80 || cy < 80 || cy > vp.clientHeight - 80) {
        setView({
          ...v,
          tx: vp.clientWidth / 2 - (node.x + PAD + node.w / 2) * v.scale,
          ty: vp.clientHeight / 2 - (node.y + PAD + node.h / 2) * v.scale
        })
      }
    },
    [layout]
  )

  const setNodeRef = useCallback(
    (id: string) =>
      (el: HTMLDivElement | null): void => {
        if (el) nodeRefs.current.set(id, el)
        else nodeRefs.current.delete(id)
      },
    []
  )

  const ws = map?.workspace ?? workspace
  const appOf = (folder?: string): TeamMapApp | undefined => map?.apps.find((a) => a.folder === folder)
  const copyOf = (node: MapNode): TeamMapCopy | undefined =>
    appOf(node.folder)?.copies.find((c) => c.branch === node.branch)

  /** The node a pipeline run belongs to. */
  const runTarget = (run: TeamMapRun): string | undefined => {
    if (!map) return undefined
    if (run.kind === 'preview') {
      for (const app of map.apps) {
        const copy = app.copies.find((c) => c.branch === run.branch)
        if (copy) return nodeIds.copy(app.folder, copy.branch)
      }
    }
    const folder = run.jobs.find((j) => j.folder)?.folder
    const app = map.apps.find((a) => a.folder.toLowerCase() === folder?.toLowerCase())
    if (!app) return undefined
    return run.kind === 'production' && app.published ? nodeIds.published(app.folder) : nodeIds.app(app.folder)
  }

  const renderNode = (node: MapNode): JSX.Element | null => {
    if (!map || !stats) return null
    switch (node.kind) {
      case 'hub':
        return (
          <>
            <div className="tmap-node-head">
              <span className="tmap-mark tmap-mark--hub">{(ws.name.trim()[0] ?? 'T').toUpperCase()}</span>
              <div className="tmap-titles">
                <strong>{ws.name}</strong>
                <span className="tmap-mono tmap-dim">{ws.repo}</span>
              </div>
            </div>
            <div className="tmap-figures" aria-label="Summary">
              <span>
                <strong>{stats.apps}</strong> {stats.apps === 1 ? 'app' : 'apps'}
              </span>
              {lens === 'data' ? (
                <>
                  <span>
                    <strong>{data.databases}</strong> {data.databases === 1 ? 'database' : 'databases'}
                  </span>
                  <span>
                    <strong>{data.connected}</strong> connected
                  </span>
                </>
              ) : (
                <>
                  <span>
                    <strong>{stats.copies}</strong> in progress
                  </span>
                  <span>
                    <strong>{stats.live}</strong> live
                  </span>
                </>
              )}
            </div>
            {map.members.length > 0 && (
              <div className="tmap-people">
                <span className="tmap-avatars">
                  {map.members.slice(0, 6).map((m) => (
                    <Avatar key={m.login} login={m.login} url={m.avatarUrl} size={20} />
                  ))}
                </span>
                <span className="tmap-dim">
                  {map.members.length} {map.members.length === 1 ? 'member' : 'members'}
                </span>
              </div>
            )}
          </>
        )
      case 'app': {
        const app = appOf(node.folder)
        if (!app) return null
        const health = app.published ? publishedHealth(app, runs) : 'idle'
        return (
          <>
            <div className="tmap-node-head">
              <span className="tmap-mark" style={{ '--hue': hueOf(app.folder) } as CSSProperties}>
                {(app.name.trim()[0] ?? '?').toUpperCase()}
              </span>
              <div className="tmap-titles">
                <strong>{app.name}</strong>
                <span className="tmap-dim">
                  {app.copies.length
                    ? `${app.copies.length} in progress`
                    : app.projectId
                      ? 'On this computer'
                      : 'No one is changing it'}
                </span>
              </div>
            </div>
            <div className="tmap-node-foot">
              {app.published ? (
                <HealthPill health={health} label={health === 'live' ? 'Published' : undefined} />
              ) : (
                <span className="tmap-health tmap-health--idle">
                  <span className="tmap-health-dot" aria-hidden="true" />
                  Not published yet
                </span>
              )}
              <button
                type="button"
                className="tmap-open"
                disabled={opening !== null}
                onClick={() => void openApp(app.folder)}
              >
                {opening === app.folder ? 'Opening…' : 'Open'}
              </button>
            </div>
          </>
        )
      }
      case 'published': {
        const app = appOf(node.folder)
        if (!app) return null
        const deploying = publishing(app, runs)
        const record = app.production
        return (
          <>
            <div className="tmap-node-head">
              <span className="tmap-icon-tile">
                <Codicon name="globe" />
              </span>
              <div className="tmap-titles">
                <strong>Published</strong>
                <span className="tmap-dim tmap-ellipsis">
                  {record?.url ? host(record.url) : 'Not deployed yet'}
                  {record?.updatedAt ? ` · ${timeAgo(record.updatedAt, now)}` : ''}
                </span>
              </div>
              <HealthPill health={publishedHealth(app, runs)} />
            </div>
            {deploying && <RunLine deploying={deploying} now={now} />}
          </>
        )
      }
      case 'copy': {
        const app = appOf(node.folder)
        const copy = copyOf(node)
        if (!app || !copy) return null
        const deploying = previewing(app, copy, runs)
        const health = copyHealth(app, copy, runs)
        const title = changeTitle(copy.pr?.title, app.name)
        const notes = [
          copy.localEdits ? 'unsaved edits' : null,
          (copy.behind ?? 0) > 0 ? `${copy.behind} behind` : null,
          copy.review === 'APPROVED' ? 'approved' : copy.review === 'CHANGES_REQUESTED' ? 'changes requested' : null,
          !deploying && health !== 'failed' && previewBehind(copy) ? 'preview is older' : null
        ].filter(Boolean)
        return (
          <>
            <div className="tmap-node-head">
              <Avatar login={copy.author || 'you'} url={copy.avatarUrl} size={28} />
              <div className="tmap-titles">
                <strong>{copy.mine ? 'You' : copy.author}</strong>
                <span className="tmap-dim">
                  {copy.pr ? `#${copy.pr.number}${copy.pr.draft ? ' · draft' : ''}` : 'Not on GitHub yet'}
                  {copy.updatedAt ? ` · ${timeAgo(copy.updatedAt, now)}` : ''}
                </span>
              </div>
              <HealthPill health={health} label={health === 'live' ? 'Preview' : undefined} />
            </div>
            {title && <div className="tmap-copy-title">{title}</div>}
            <div className="tmap-node-foot">
              <DiffBar additions={copy.additions} deletions={copy.deletions} />
              <span className="tmap-dim tmap-ellipsis">
                {copy.changedFiles} {copy.changedFiles === 1 ? 'file' : 'files'}
                {notes.length ? ` · ${notes.join(' · ')}` : ''}
              </span>
            </div>
            {deploying && <RunLine deploying={deploying} now={now} />}
          </>
        )
      }
      case 'fabric-prod':
      case 'fabric-preview': {
        const prod = node.kind === 'fabric-prod'
        const fabric = ws.manifest?.fabric
        const target = prod ? fabric?.production : fabric?.previews
        const healths: Health[] = map.apps.flatMap((app) =>
          prod ? (app.published ? [publishedHealth(app, runs)] : []) : app.copies.map((c) => copyHealth(app, c, runs))
        )
        const count = (h: Health): number => healths.filter((x) => x === h).length
        return (
          <>
            <div className="tmap-node-head">
              <FabricGlyph />
              <div className="tmap-titles">
                <strong>{prod ? 'Published apps' : 'Previews'}</strong>
                <span className="tmap-dim tmap-ellipsis">{target?.name ?? 'Fabric workspace'}</span>
              </div>
            </div>
            <div className="tmap-node-foot">
              <span className="tmap-dim">
                {count('live')} live
                {count('deploying') ? ` · ${count('deploying')} deploying` : ''}
                {count('failed') ? ` · ${count('failed')} failed` : ''}
              </span>
            </div>
          </>
        )
      }
      case 'resource': {
        const item = itemById.get(node.id)
        return item ? <ResourceNodeBody item={item} /> : null
      }
      case 'resource-empty':
        return <EmptyNodeBody loading={!dataView} error={dataView?.apps[node.folder ?? '']?.error} />
      case 'source': {
        const source = sourceById.get(node.id)
        return source && dataView ? <SourceNodeBody source={source} apps={sourceApps(map, dataView, source)} /> : null
      }
    }
  }

  const nodeHealth = (node: MapNode): Health | undefined => {
    const app = appOf(node.folder)
    if (!app) return undefined
    if (node.kind === 'app') return appHealth(app, runs)
    if (node.kind === 'published') return publishedHealth(app, runs)
    if (node.kind === 'copy') {
      const copy = copyOf(node)
      return copy ? copyHealth(app, copy, runs) : undefined
    }
    return undefined
  }

  return (
    <div className="tmap" role="region" aria-label={`${ws.name} overview`}>
      <header className="tmap-head">
        <div className="tmap-head-title">
          <span className="tmap-head-glyph" aria-hidden="true">
            <Codicon name="type-hierarchy-sub" />
          </span>
          <h2 className="tmap-title">{ws.name}</h2>
          <button
            type="button"
            className="tmap-repo"
            onClick={() => void window.api.openExternal(`https://github.com/${ws.repo}`)}
            title="Open on GitHub"
          >
            <Codicon name="github" /> {ws.repo}
          </button>
        </div>
        <div className="seg tmap-lens" role="tablist" aria-label="Show">
          <button
            type="button"
            role="tab"
            aria-selected={lens === 'changes'}
            className={`seg-btn${lens === 'changes' ? ' seg-btn--active' : ''}`}
            onClick={() => switchLens('changes')}
            title="Everyone's changes, previews and what's deploying"
          >
            <Codicon name="git-pull-request" /> Changes
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={lens === 'data'}
            className={`seg-btn${lens === 'data' ? ' seg-btn--active' : ''}`}
            onClick={() => switchLens('data')}
            title="Each app's database, functions and connectors, and what they connect to"
          >
            <Codicon name="database" /> Data &amp; connections
          </button>
        </div>
        <div className="tmap-tools">
          {stats && stats.deploying > 0 && (
            <span className="tmap-health tmap-health--deploying tmap-head-status">
              <span className="tmap-health-dot" aria-hidden="true" />
              {stats.deploying} deploying
            </span>
          )}
          {onNewApp && (
            <button type="button" className="model-tool-btn" onClick={() => onNewApp(workspace.id)}>
              <Codicon name="add" /> New app
            </button>
          )}
          <button
            type="button"
            className={`model-tool-btn${selection === nodeIds.hub ? ' tmap-tool--on' : ''}`}
            onClick={() => setSelection(selection === nodeIds.hub ? null : nodeIds.hub)}
            aria-pressed={selection === nodeIds.hub}
            title="Members, app access and settings"
          >
            <Codicon name="gear" /> Manage
          </button>
          <button type="button" className="model-tool-btn" onClick={() => void load()} disabled={loading} title="Refresh">
            <Codicon name="refresh" className={loading ? 'tmap-spin' : undefined} />
          </button>
          <div className="model-zoom" role="group" aria-label="Zoom">
            <button type="button" className="model-zoom-btn" onClick={() => zoomBy(0.8)} aria-label="Zoom out">
              <Codicon name="zoom-out" />
            </button>
            <button type="button" className="model-zoom-label" onClick={() => fitTo()} title="Fit to window">
              {Math.round(view.scale * 100)}%
            </button>
            <button type="button" className="model-zoom-btn" onClick={() => zoomBy(1.25)} aria-label="Zoom in">
              <Codicon name="zoom-in" />
            </button>
          </div>
          <button type="button" className="model-tool-btn" onClick={() => fitTo()} title="Fit to window">
            <Codicon name="screen-full" />
          </button>
          <button type="button" className="model-tool-btn" onClick={onClose} aria-label="Close the overview" title="Close (Esc)">
            <Codicon name="close" />
          </button>
        </div>
      </header>

      {error && <div className="alert alert--error tmap-alert">{error}</div>}

      <div className="tmap-body">
        <div
          className="tmap-viewport"
          ref={viewportRef}
          data-panning={panning ? 'true' : undefined}
          onPointerDown={onBackgroundDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
        >
          {!layout ? (
            <div className="tmap-loading">
              <span className="tmap-spinner tmap-spinner--lg" />
              <span>Loading {workspace.name}…</span>
            </div>
          ) : (
            <div
              className="tmap-canvas"
              style={{
                width: layout.width + PAD * 2,
                height: layout.height + PAD * 2,
                transform: `translate(${Math.round(view.tx)}px, ${Math.round(view.ty)}px) scale(${view.scale})`
              }}
            >
              {layout.lanes.map((lane) => (
                <div key={lane.label} className="tmap-lane" style={{ left: lane.x + PAD, top: PAD, width: lane.w }}>
                  {lane.label}
                </div>
              ))}
              <svg className="tmap-edges" width={layout.width + PAD * 2} height={layout.height + PAD * 2} aria-hidden="true">
                <g transform={`translate(${PAD} ${PAD})`}>
                  {layout.edges.map((edge) => {
                    const mood = focusSet
                      ? focusSet.has(edge.from) && focusSet.has(edge.to)
                        ? ' tmap-edge--hot'
                        : ' tmap-edge--dim'
                      : ''
                    return (
                      <g
                        key={edge.id}
                        className={`tmap-edge tmap-edge--${edge.kind} tmap-edge--${edge.health}${
                          edge.production ? ' tmap-edge--prod' : ''
                        }${edge.draft ? ' tmap-edge--draft' : ''}${mood}`}
                      >
                        <path d={edge.d} className="tmap-edge-base" />
                        {edge.health === 'deploying' && edge.kind === 'deploy' && (
                          <path d={edge.d} className="tmap-edge-flow" />
                        )}
                      </g>
                    )
                  })}
                </g>
              </svg>

              {layout.nodes.map((node) => {
                const health = nodeHealth(node)
                const dim = focusSet ? !focusSet.has(node.id) : false
                // The "nothing here" placeholder stands for its app.
                const target = node.kind === 'resource-empty' && node.folder ? nodeIds.app(node.folder) : node.id
                const selected = selection === node.id
                return (
                  <div
                    key={node.id}
                    ref={setNodeRef(node.id)}
                    className={`tmap-node tmap-node--${node.kind}${health ? ` tmap-node--${health}` : ''}${
                      node.draft ? ' tmap-node--draft' : ''
                    }${dim ? ' tmap-node--dim' : ''}${selected ? ' tmap-node--selected' : ''}`}
                    style={{ left: node.x + PAD, top: node.y + PAD, width: node.w }}
                    role="button"
                    tabIndex={0}
                    aria-pressed={selected}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest('button, a')) return
                      setSelection(selected ? null : target)
                    }}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setSelection(selected ? null : target)
                      }
                    }}
                    onMouseEnter={() => setHovered(node.id)}
                    onMouseLeave={() => setHovered((h) => (h === node.id ? null : h))}
                  >
                    {renderNode(node)}
                  </div>
                )
              })}
            </div>
          )}

          {map && map.apps.length === 0 && (
            <div className="tmap-empty">
              <strong>No apps yet</strong>
              <span>Create the first app in this workspace; it shows up here with everyone&apos;s work on it.</span>
              {onNewApp && (
                <button type="button" className="btn btn--sm btn--primary" onClick={() => onNewApp(workspace.id)}>
                  <Codicon name="add" /> New app
                </button>
              )}
            </div>
          )}
        </div>

        {selection === nodeIds.hub ? (
          <WorkspacePanel
            workspace={ws}
            viewer={map?.viewer}
            onClose={() => setSelection(null)}
            onChanged={() => {
              void load()
              onChanged?.()
            }}
            onGone={() => onChanged?.()}
          />
        ) : map && selection && (selection.startsWith('res:') || selection.startsWith('src:')) ? (
          dataView ? (
            <ResourceDetails
              map={map}
              view={dataView}
              selection={selection}
              opening={opening}
              onClose={() => setSelection(null)}
              onSelect={reveal}
              onOpenApp={(folder) => void openApp(folder)}
            />
          ) : null
        ) : map && selection ? (
          <Inspector
            workspace={ws}
            map={map}
            runs={runs}
            selection={selection}
            opening={opening}
            onClose={() => setSelection(null)}
            onSelect={reveal}
            onOpenApp={(folder) => void openApp(folder)}
            onRemoved={() => {
              setSelection(null)
              void load()
              onChanged?.()
            }}
          />
        ) : map && lens === 'data' ? (
          <DataPanel map={map} view={dataView} loading={dataLoading} error={dataError} onReveal={reveal} />
        ) : map ? (
          <ActivityPanel map={map} runs={runs} now={now} targetOf={runTarget} onReveal={reveal} />
        ) : null}
      </div>
    </div>
  )
}
