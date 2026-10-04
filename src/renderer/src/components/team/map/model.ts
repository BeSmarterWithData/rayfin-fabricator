import type { TeamDeployRecord, TeamMap, TeamMapApp, TeamMapCopy, TeamMapJob, TeamMapRun } from '@shared/ipc'
import { dataIds, type ResourceView } from './resources'

/** How a deployment target is doing. */
export type Health = 'live' | 'deploying' | 'failed' | 'idle'

/** A run deploying something right now (and its job, once the plan is done). */
export interface Deploying {
  run: TeamMapRun
  job?: TeamMapJob
}

const same = (a?: string, b?: string): boolean => Boolean(a && b && a.toLowerCase() === b.toLowerCase())

export function isActive(run: TeamMapRun): boolean {
  return run.status !== 'completed'
}

/** The run deploying an app's published version right now. */
export function publishing(app: TeamMapApp, runs: TeamMapRun[]): Deploying | undefined {
  for (const run of runs) {
    if (!isActive(run) || run.kind !== 'production') continue
    const job = run.jobs.find((j) => same(j.folder, app.folder))
    if (job && job.conclusion !== 'skipped') return { run, job }
  }
  return undefined
}

/** The run deploying a working copy's preview right now. */
export function previewing(app: TeamMapApp, copy: TeamMapCopy, runs: TeamMapRun[]): Deploying | undefined {
  for (const run of runs) {
    if (!isActive(run) || run.kind !== 'preview' || run.branch !== copy.branch) continue
    const job = run.jobs.find((j) => same(j.folder, app.folder))
    if (job?.conclusion === 'skipped') continue
    // Planned, but not for this app.
    if (!job && run.jobs.some((j) => j.folder)) continue
    return { run, job }
  }
  return undefined
}

export function recordHealth(record?: TeamDeployRecord): Health {
  switch (record?.state) {
    case 'success':
    case 'inactive':
      return 'live'
    case 'failure':
    case 'error':
      return 'failed'
    case 'in_progress':
    case 'queued':
    case 'pending':
      return 'deploying'
    default:
      return 'idle'
  }
}

export function publishedHealth(app: TeamMapApp, runs: TeamMapRun[]): Health {
  return publishing(app, runs) ? 'deploying' : recordHealth(app.production)
}

export function copyHealth(app: TeamMapApp, copy: TeamMapCopy, runs: TeamMapRun[]): Health {
  return previewing(app, copy, runs) ? 'deploying' : recordHealth(copy.preview)
}

/** The most notable state among an app's targets (deploying beats failed beats live). */
export function appHealth(app: TeamMapApp, runs: TeamMapRun[]): Health {
  const all: Health[] = [
    ...(app.published ? [publishedHealth(app, runs)] : []),
    ...app.copies.map((c) => copyHealth(app, c, runs))
  ]
  for (const h of ['deploying', 'failed', 'live'] as const) if (all.includes(h)) return h
  return 'idle'
}

/** The copy's preview was deployed from an earlier save than its latest. */
export function previewBehind(copy: TeamMapCopy): boolean {
  const head = copy.pr?.headSha
  return Boolean(head && copy.preview?.sha && copy.preview.sha !== head)
}

export interface MapStats {
  apps: number
  published: number
  copies: number
  live: number
  deploying: number
  failed: number
}

export function mapStats(map: TeamMap, runs: TeamMapRun[]): MapStats {
  let live = 0
  let failed = 0
  let copies = 0
  const count = (h: Health): void => {
    if (h === 'live') live += 1
    if (h === 'failed') failed += 1
  }
  for (const app of map.apps) {
    if (app.published) count(publishedHealth(app, runs))
    for (const copy of app.copies) {
      copies += 1
      count(copyHealth(app, copy, runs))
    }
  }
  return {
    apps: map.apps.length,
    published: map.apps.filter((a) => a.published).length,
    copies,
    live,
    deploying: runs.filter((r) => isActive(r) && r.kind !== 'verify').length,
    failed
  }
}

/** The app folder of a working branch (`fabricator/<login>/<folder>-<stamp>`). */
export function branchFolder(branch?: string): string | undefined {
  return /^fabricator\/[^/]+\/(.+)-\d{8}-\d{6}$/.exec(branch ?? '')?.[1]
}

/** A short description of what a run is doing (or did), for people. */
export function runLabel(run: TeamMapRun, apps: TeamMapApp[]): string {
  const folders = run.jobs.map((j) => j.folder).filter((f): f is string => Boolean(f))
  const fromBranch = run.kind === 'preview' ? branchFolder(run.branch) : undefined
  if (!folders.length && fromBranch) folders.push(fromBranch)
  const names = folders.map((f) => apps.find((a) => same(a.folder, f))?.name ?? f)
  const what = names.length ? names.join(', ') : undefined
  const done = !isActive(run)
  switch (run.kind) {
    case 'preview':
      return what ? `Preview of ${what}` : 'Preview'
    case 'production':
      if (what) return `${done ? 'Published' : 'Publishing'} ${what}`
      if (done && run.title) return `Published: ${run.title.replace(/\s*\(#\d+\)$/, '')}`
      return done ? 'Published' : 'Publishing'
    case 'verify':
      return 'Checking Fabric access'
    default:
      return run.title ?? 'Pipeline run'
  }
}

/* --------------------------------- layout --------------------------------- */

export type NodeKind =
  | 'hub'
  | 'app'
  | 'published'
  | 'copy'
  | 'fabric-prod'
  | 'fabric-preview'
  /** Data view: something an app has (database, files, functions, a connector). */
  | 'resource'
  /** Data view: an app with nothing to show there. */
  | 'resource-empty'
  /** Data view: a Fabric item or service apps connect to. */
  | 'source'

export interface MapNode {
  id: string
  kind: NodeKind
  x: number
  y: number
  w: number
  h: number
  folder?: string
  branch?: string
  /** Only in working copies so far (data view). */
  draft?: boolean
}

export interface MapEdge {
  id: string
  from: string
  to: string
  kind: 'tree' | 'deploy' | 'link'
  health: Health
  /** The deploy target is the published app (vs. a preview). */
  production?: boolean
  /** Only in working copies so far (data view). */
  draft?: boolean
  d: string
}

export interface MapLayout {
  nodes: MapNode[]
  edges: MapEdge[]
  /** Column headings, above the nodes. */
  lanes: MapLane[]
  width: number
  height: number
}

export interface MapLane {
  label: string
  x: number
  w: number
}

export const NODE_WIDTH: Record<NodeKind, number> = {
  hub: 248,
  app: 240,
  published: 292,
  copy: 292,
  'fabric-prod': 232,
  'fabric-preview': 232,
  resource: 292,
  'resource-empty': 292,
  source: 232
}

/** First-render guesses; real heights are measured and fed back in. */
const ESTIMATE: Record<NodeKind, number> = {
  hub: 150,
  app: 96,
  published: 64,
  copy: 124,
  'fabric-prod': 88,
  'fabric-preview': 88,
  resource: 64,
  'resource-empty': 44,
  source: 76
}

const COLUMN: Record<NodeKind, number> = {
  hub: 0,
  app: 312,
  published: 616,
  copy: 616,
  'fabric-prod': 984,
  'fabric-preview': 984,
  resource: 616,
  'resource-empty': 616,
  source: 984
}

const ROW_GAP = 14
const APP_GAP = 40
const FABRIC_GAP = 48
const SOURCE_GAP = 18
/** Room above the nodes for the column headings. */
const LANE_SPACE = 44

export const nodeIds = {
  hub: 'hub',
  app: (folder: string): string => `app:${folder}`,
  published: (folder: string): string => `pub:${folder}`,
  copy: (folder: string, branch: string): string => `copy:${folder}:${branch}`,
  fabricProd: 'fabric:prod',
  fabricPreview: 'fabric:preview'
}

/**
 * A tree connector between two nodes: across, then down (or up) with rounded
 * corners halfway, then across again. Siblings share the vertical run, so a
 * parent's links read as one bracket.
 */
export function curve(a: MapNode, b: MapNode): string {
  const x1 = a.x + a.w
  const y1 = Math.round(a.y + a.h / 2) + 0.5
  const x2 = b.x
  const y2 = Math.round(b.y + b.h / 2) + 0.5
  const mid = Math.round(x1 + (x2 - x1) / 2) + 0.5
  const dy = y2 - y1
  if (Math.abs(dy) < 1) return `M ${x1} ${y1} L ${x2} ${y2}`
  const r = Math.min(10, Math.abs(dy) / 2, (x2 - x1) / 4)
  const s = dy > 0 ? 1 : -1
  return `M ${x1} ${y1} L ${mid - r} ${y1} Q ${mid} ${y1} ${mid} ${y1 + s * r} L ${mid} ${y2 - s * r} Q ${mid} ${y2} ${mid + r} ${y2} L ${x2} ${y2}`
}

interface Row {
  id: string
  kind: NodeKind
  branch?: string
  draft?: boolean
}

/** Places nodes in their columns, at heights measured (or guessed) by id. */
function nodeBuilder(heights: Record<string, number>): {
  nodes: MapNode[]
  height: (id: string, kind: NodeKind) => number
  place: (id: string, kind: NodeKind, y: number, extra?: Partial<MapNode>) => MapNode
} {
  const nodes: MapNode[] = []
  const height = (id: string, kind: NodeKind): number => heights[id] ?? ESTIMATE[kind]
  const place = (id: string, kind: NodeKind, y: number, extra: Partial<MapNode> = {}): MapNode => {
    const node: MapNode = { id, kind, x: COLUMN[kind], y, w: NODE_WIDTH[kind], h: height(id, kind), ...extra }
    nodes.push(node)
    return node
  }
  return { nodes, height, place }
}

/**
 * Stack the apps top to bottom, each beside its rows (centred on each other),
 * and the workspace beside them all. Returns the bottom of the stack.
 */
function stackApps(
  map: TeamMap,
  rowsOf: (app: TeamMapApp) => Row[],
  { height, place }: Pick<ReturnType<typeof nodeBuilder>, 'height' | 'place'>
): number {
  let cursor = 0
  for (const app of map.apps) {
    const rows = rowsOf(app)
    const rowsHeight =
      rows.reduce((sum, r) => sum + height(r.id, r.kind), 0) + Math.max(0, rows.length - 1) * ROW_GAP
    const appId = nodeIds.app(app.folder)
    const appHeight = height(appId, 'app')
    const block = Math.max(rowsHeight, appHeight)
    let y = cursor + (block - rowsHeight) / 2
    for (const row of rows) {
      const extra: Partial<MapNode> = { folder: app.folder }
      if (row.branch) extra.branch = row.branch
      if (row.draft) extra.draft = true
      y += place(row.id, row.kind, y, extra).h + ROW_GAP
    }
    place(appId, 'app', cursor + (block - appHeight) / 2, { folder: app.folder })
    cursor += block + APP_GAP
  }
  const bottom = Math.max(0, cursor - APP_GAP)
  place(nodeIds.hub, 'hub', bottom / 2 - height(nodeIds.hub, 'hub') / 2)
  return bottom
}

/** Move everything below the column headings, and size the canvas. */
function finish(nodes: MapNode[], edges: MapEdge[], lanes: MapLane[]): MapLayout {
  const top = Math.min(...nodes.map((n) => n.y))
  for (const node of nodes) node.y = Math.round(node.y - top) + LANE_SPACE
  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (const edge of edges) {
    const a = byId.get(edge.from)
    const b = byId.get(edge.to)
    if (a && b) edge.d = curve(a, b)
  }
  return {
    nodes,
    edges: edges.filter((e) => e.d),
    lanes,
    width: Math.max(...nodes.map((n) => n.x + n.w)),
    height: Math.max(...nodes.map((n) => n.y + n.h))
  }
}

/**
 * Lay the workspace out as a tree, left to right: the workspace, its apps,
 * each app's published version and working copies, and the two Fabric
 * workspaces they deploy to. `heights` are measured node heights by id.
 */
export function layoutMap(map: TeamMap, runs: TeamMapRun[], heights: Record<string, number> = {}): MapLayout {
  const { nodes, height, place } = nodeBuilder(heights)
  const bottom = stackApps(
    map,
    (app) => [
      ...(app.published ? [{ id: nodeIds.published(app.folder), kind: 'published' as const }] : []),
      ...app.copies.map((c) => ({ id: nodeIds.copy(app.folder, c.branch), kind: 'copy' as const, branch: c.branch }))
    ],
    { height, place }
  )
  const published = nodes.filter((n) => n.kind === 'published')
  const copies = nodes.filter((n) => n.kind === 'copy')

  // The Fabric workspaces sit level with what deploys to them, published above previews.
  const centre = (list: MapNode[], fallback: number): number =>
    list.length ? list.reduce((sum, n) => sum + n.y + n.h / 2, 0) / list.length : fallback
  const prodHeight = height(nodeIds.fabricProd, 'fabric-prod')
  const previewHeight = height(nodeIds.fabricPreview, 'fabric-preview')
  let prodCentre = centre(published, bottom / 2 - prodHeight / 2)
  let previewCentre = centre(copies, bottom / 2 + previewHeight / 2)
  const apart = (prodHeight + previewHeight) / 2 + FABRIC_GAP
  if (previewCentre - prodCentre < apart) {
    const mid = (prodCentre + previewCentre) / 2
    prodCentre = mid - apart / 2
    previewCentre = mid + apart / 2
  }
  place(nodeIds.fabricProd, 'fabric-prod', prodCentre - prodHeight / 2)
  place(nodeIds.fabricPreview, 'fabric-preview', previewCentre - previewHeight / 2)

  const edges: MapEdge[] = []
  const link = (from: string, to: string, kind: MapEdge['kind'], health: Health, production?: boolean): void => {
    edges.push({ id: `${from}->${to}`, from, to, kind, health, production, d: '' })
  }
  for (const app of map.apps) {
    const appId = nodeIds.app(app.folder)
    link(nodeIds.hub, appId, 'tree', appHealth(app, runs))
    if (app.published) {
      const pub = nodeIds.published(app.folder)
      const health = publishedHealth(app, runs)
      link(appId, pub, 'tree', health)
      link(pub, nodeIds.fabricProd, 'deploy', health, true)
    }
    for (const copy of app.copies) {
      const id = nodeIds.copy(app.folder, copy.branch)
      const health = copyHealth(app, copy, runs)
      link(appId, id, 'tree', health)
      link(id, nodeIds.fabricPreview, 'deploy', health, false)
    }
  }

  return finish(nodes, edges, [
    { label: 'Workspace', x: COLUMN.hub, w: NODE_WIDTH.hub },
    { label: 'Apps', x: COLUMN.app, w: NODE_WIDTH.app },
    { label: 'Published & in progress', x: COLUMN.copy, w: NODE_WIDTH.copy },
    { label: 'Deployed to Fabric', x: COLUMN['fabric-prod'], w: NODE_WIDTH['fabric-prod'] }
  ])
}

/**
 * The data view, left to right: the workspace, its apps, what each app has
 * (its database, file storage, functions and connectors), and the Fabric items
 * and services those connect to. A source several apps use is drawn once,
 * level with what connects to it.
 */
export function layoutData(map: TeamMap, view: ResourceView | null, heights: Record<string, number> = {}): MapLayout {
  const { nodes, height, place } = nodeBuilder(heights)
  stackApps(
    map,
    (app) => {
      const items = view?.apps[app.folder]?.items ?? []
      return items.length
        ? items.map((item) => ({ id: item.id, kind: 'resource' as const, draft: !item.published }))
        : [{ id: dataIds.empty(app.folder), kind: 'resource-empty' as const }]
    },
    { height, place }
  )

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const centreOf = (ids: string[]): number => {
    const placed = ids.map((id) => byId.get(id)).filter((n): n is MapNode => Boolean(n))
    return placed.length ? placed.reduce((sum, n) => sum + n.y + n.h / 2, 0) / placed.length : 0
  }
  // Each source sits level with what connects to it, pushed down to not overlap.
  const wanted = (view?.sources ?? [])
    .map((source) => ({ source, centre: centreOf(source.users) }))
    .sort((a, b) => a.centre - b.centre)
  let floor = -Infinity
  for (const { source, centre } of wanted) {
    const h = height(source.id, 'source')
    const y = Math.max(centre - h / 2, floor)
    place(source.id, 'source', y, source.published ? {} : { draft: true })
    floor = y + h + SOURCE_GAP
  }

  const edges: MapEdge[] = []
  const link = (from: string, to: string, kind: MapEdge['kind'], draft?: boolean): void => {
    edges.push({ id: `${from}->${to}`, from, to, kind, health: 'idle', draft: draft || undefined, d: '' })
  }
  for (const app of map.apps) {
    const appId = nodeIds.app(app.folder)
    link(nodeIds.hub, appId, 'tree')
    const items = view?.apps[app.folder]?.items ?? []
    if (!items.length) link(appId, dataIds.empty(app.folder), 'tree')
    for (const item of items) {
      link(appId, item.id, 'tree', !item.published)
      for (const target of item.links) link(item.id, target.id, 'link', target.draft || !item.published)
    }
  }

  return finish(nodes, edges, [
    { label: 'Workspace', x: COLUMN.hub, w: NODE_WIDTH.hub },
    { label: 'Apps', x: COLUMN.app, w: NODE_WIDTH.app },
    { label: 'Inside each app', x: COLUMN.resource, w: NODE_WIDTH.resource },
    ...(view?.sources.length ? [{ label: 'Connected to', x: COLUMN.source, w: NODE_WIDTH.source }] : [])
  ])
}

/**
 * The nodes related to `id`, to highlight together: what leads to it and what
 * it leads to. Everything belongs to the workspace, so the workspace relates to
 * every node; a Fabric workspace relates to what deploys to it.
 */
export function lineage(layout: MapLayout, id: string): Set<string> {
  if (id === nodeIds.hub) return new Set(layout.nodes.map((n) => n.id))
  const out = new Set<string>([id])
  const up = (target: string): void => {
    for (const e of layout.edges) {
      if (e.to === target && !out.has(e.from)) {
        out.add(e.from)
        up(e.from)
      }
    }
  }
  const down = (source: string): void => {
    for (const e of layout.edges) {
      if (e.from === source && !out.has(e.to)) {
        out.add(e.to)
        down(e.to)
      }
    }
  }
  up(id)
  if (!id.startsWith('fabric:')) down(id)
  return out
}
