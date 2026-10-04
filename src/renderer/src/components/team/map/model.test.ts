import { describe, expect, it } from 'vitest'
import type { TeamMapRun } from '@shared/ipc'
import { AMYS, MINE, SALES_ITEM, sampleMap, sampleResources } from './fixtures'
import {
  appHealth,
  changingLabel,
  copyHealth,
  fabricHealth,
  layoutMap,
  lineage,
  mapStats,
  nodeIds,
  previewBehind,
  previewing,
  publishedHealth,
  publishing,
  runLabel,
  wire,
  type MapLayout,
  type MapNode
} from './model'
import { buildResourceView, dataIds, parseSources, resourceRequests, type ResourceView } from './resources'

const mine = MINE
const amys = AMYS

function run(over: Partial<TeamMapRun>): TeamMapRun {
  return { id: 1, kind: 'preview', status: 'in_progress', url: 'https://run', sha: 'h4', jobs: [], ...over }
}

describe('workspace map model', () => {
  it('matches pipeline runs to the copies and published apps they deploy', () => {
    const map = sampleMap()
    const [trips, notes] = map.apps
    const [, amy] = trips.copies
    const planning = run({ branch: amys })
    expect(previewing(trips, amy, [planning])?.run).toBe(planning)
    const deploying = run({ branch: amys, jobs: [{ name: 'Preview trips', folder: 'trips', status: 'in_progress', steps: [] }] })
    expect(previewing(trips, amy, [deploying])?.job?.name).toBe('Preview trips')
    const elsewhere = run({ branch: amys, jobs: [{ name: 'Preview notes', folder: 'notes', status: 'in_progress', steps: [] }] })
    expect(previewing(trips, amy, [elsewhere])).toBeUndefined()
    expect(previewing(trips, amy, [run({ branch: amys, status: 'completed' })])).toBeUndefined()

    const publish = run({ kind: 'production', branch: 'main', jobs: [] })
    expect(publishing(trips, [publish])).toBeUndefined()
    const publishTrips = run({ kind: 'production', branch: 'main', jobs: [{ name: 'Deploy trips', folder: 'trips', status: 'queued', steps: [] }] })
    expect(publishing(trips, [publishTrips])?.job?.folder).toBe('trips')
    expect(publishing(notes, [publishTrips])).toBeUndefined()
  })

  it('derives health from deployments and the runs in progress', () => {
    const map = sampleMap()
    const [trips, notes] = map.apps
    const [me, amy] = trips.copies
    const runs = [run({ branch: amys })]
    expect(copyHealth(trips, me, runs)).toBe('live')
    expect(copyHealth(trips, amy, [])).toBe('failed')
    expect(copyHealth(trips, amy, runs)).toBe('deploying')
    expect(publishedHealth(trips, runs)).toBe('live')
    expect(appHealth(trips, runs)).toBe('deploying')
    expect(appHealth(trips, [])).toBe('failed')
    expect(appHealth(notes, [])).toBe('idle')
    expect(previewBehind(me)).toBe(true)
    expect(previewBehind(amy)).toBe(false)
  })

  it('counts apps, copies and what is live or deploying', () => {
    const stats = mapStats(sampleMap(), [run({ branch: amys }), run({ kind: 'verify' })])
    expect(stats).toEqual({ apps: 2, published: 1, copies: 3, live: 2, deploying: 1, failed: 0 })
  })

  it('describes runs in plain words', () => {
    const apps = sampleMap().apps
    expect(runLabel(run({ jobs: [{ name: 'Preview trips', folder: 'trips', status: 'queued', steps: [] }] }), apps)).toBe(
      'Preview of Trip Logger'
    )
    // A finished run's jobs aren't read again: the branch names the app.
    expect(runLabel(run({ status: 'completed', branch: amys }), apps)).toBe('Preview of Trip Logger')
    expect(runLabel(run({ kind: 'production' }), apps)).toBe('Publishing')
    expect(runLabel(run({ kind: 'production', status: 'completed', title: 'Notes: add tags (#9)' }), apps)).toBe(
      'Published: Notes: add tags'
    )
    expect(
      runLabel(run({ kind: 'production', status: 'completed', jobs: [{ name: 'Deploy trips', folder: 'trips', status: 'completed', steps: [] }] }), apps)
    ).toBe('Published Trip Logger')
    expect(runLabel(run({ kind: 'verify' }), apps)).toBe('Checking Fabric access')
  })

  it('says who is changing an app', () => {
    const [trips, notes] = sampleMap().apps
    expect(changingLabel(trips)).toBe('You and amy are changing it')
    expect(changingLabel(notes)).toBe('You’re changing it')
    expect(changingLabel({ ...trips, copies: [] })).toBe('No one is changing it')
    expect(changingLabel({ ...trips, copies: [trips.copies[1]] })).toBe('amy is changing it')
    const bo = { ...trips.copies[1], author: 'bo', branch: 'b' }
    const cy = { ...trips.copies[1], author: 'cy', branch: 'c' }
    expect(changingLabel({ ...trips, copies: [...trips.copies, bo, cy] })).toBe('4 people are changing it')
  })

  it('counts what each Fabric workspace hosts and how it is doing', () => {
    const map = sampleMap()
    expect(fabricHealth(map, [], true)).toEqual({ live: 1, deploying: 0, failed: 0, idle: 0 })
    expect(fabricHealth(map, [], false)).toEqual({ live: 1, deploying: 0, failed: 1, idle: 1 })
    expect(fabricHealth(map, [run({ branch: amys })], false)).toEqual({ live: 1, deploying: 1, failed: 0, idle: 1 })
  })
})

async function sampleView(): Promise<ResourceView> {
  const map = sampleMap()
  return buildResourceView(map, await parseSources(sampleResources(resourceRequests(map))))
}

describe('workspace map layout', () => {
  it('lays each app out with its versions on its left and its data on its right', () => {
    const map = sampleMap()
    const layout = layoutMap(map, [run({ branch: amys })], null)
    // Two apps, their four versions, and a placeholder per app while their data is read.
    expect(layout.nodes).toHaveLength(2 + 4 + 2)
    expect(layout.lanes.map((l) => l.label)).toEqual(['Published & in progress', 'Apps', 'Data & connections'])
    // Nodes start below the column headings, on whole pixels.
    expect(Math.min(...layout.nodes.map((n) => n.y))).toBeGreaterThanOrEqual(40)
    expect(layout.nodes.every((n) => Number.isInteger(n.y))).toBe(true)
    // Versions, then apps, then data, left to right; nothing overlaps within a column.
    const node = (id: string): MapNode => layout.nodes.find((n) => n.id === id)!
    const trips = node(nodeIds.app('trips'))
    const published = node(nodeIds.published('trips'))
    expect(published.x + published.w).toBeLessThan(trips.x)
    expect(node(dataIds.empty('trips')).x).toBeGreaterThan(trips.x + trips.w)
    for (const kinds of [['published', 'copy'], ['app'], ['resource', 'resource-empty']]) {
      const column = layout.nodes.filter((n) => kinds.includes(n.kind)).sort((a, b) => a.y - b.y)
      for (let i = 1; i < column.length; i++) expect(column[i].y).toBeGreaterThanOrEqual(column[i - 1].y + column[i - 1].h)
    }
    // Each app sits level with the middle of its versions.
    const last = node(nodeIds.copy('trips', amys))
    expect(Math.abs(trips.y + trips.h / 2 - (published.y + last.y + last.h) / 2)).toBeLessThanOrEqual(1)
    // A version's line carries how its deployment is doing.
    const amyLine = layout.edges.find((e) => e.from === last.id)
    expect(amyLine).toMatchObject({ kind: 'version', to: trips.id, health: 'deploying' })
    expect(amyLine?.d.startsWith(`M ${last.x + last.w} `)).toBe(true)
    expect(layout.edges.find((e) => e.from === published.id)).toMatchObject({ health: 'live', production: true })
    // Nothing to lay out without apps.
    expect(layoutMap({ ...map, apps: [] }, [], null)).toMatchObject({ nodes: [], edges: [], width: 0, height: 0 })
  })

  it('makes room for nodes measured taller than estimated', () => {
    const map = sampleMap()
    const before = layoutMap(map, [], null)
    const first = nodeIds.published('trips')
    const after = layoutMap(map, [], null, { [first]: 400 })
    const y = (l: MapLayout, id: string): number => l.nodes.find((n) => n.id === id)!.y
    expect(y(after, nodeIds.copy('trips', mine)) - y(after, first)).toBeGreaterThanOrEqual(400)
    // The next app moves down to make room.
    expect(y(after, nodeIds.app('notes'))).toBeGreaterThan(y(before, nodeIds.app('notes')))
  })

  it('connects nodes with smooth lines, straight when nearly level', () => {
    const a = { id: 'a', kind: 'app' as const, x: 0, y: 0, w: 100, h: 40 }
    // Level, or within a few pixels of it: straight, keeping the shared end where it is.
    expect(wire(a, { ...a, id: 'b', x: 200 }).d).toBe('M 100 20.5 L 200 20.5')
    expect(wire(a, { ...a, id: 'b', x: 200, y: 3 }, 'to')).toEqual({
      d: 'M 100 23.5 L 200 23.5',
      x1: 100,
      y1: 23.5,
      x2: 200,
      y2: 23.5
    })
    // Otherwise it bends smoothly, leaving and arriving level.
    expect(wire(a, { ...a, id: 'c', x: 200, y: 100 })).toEqual({
      d: 'M 100 20.5 C 150 20.5 150 120.5 200 120.5',
      x1: 100,
      y1: 20.5,
      x2: 200,
      y2: 120.5
    })
  })

  it('highlights what relates to an app, a version, a resource, a source or a Fabric workspace', async () => {
    const layout = layoutMap(sampleMap(), [], await sampleView())
    const trips = nodeIds.app('trips')
    const sales = dataIds.source(`item:${SALES_ITEM}`)
    const connector = dataIds.item('trips', 'connector:sales')
    // An app: its versions, what it has and what that connects to; not other apps.
    const app = lineage(layout, trips)
    for (const id of [nodeIds.published('trips'), nodeIds.copy('trips', amys), dataIds.item('trips', 'database'), connector, sales]) {
      expect(app.has(id)).toBe(true)
    }
    expect(app.has(nodeIds.app('notes'))).toBe(false)
    // A version: itself and its app.
    expect([...lineage(layout, nodeIds.copy('trips', amys))].sort()).toEqual([nodeIds.copy('trips', amys), trips].sort())
    // Something an app has: its app and what it connects to.
    expect([...lineage(layout, connector)].sort()).toEqual([connector, trips, sales].sort())
    // A source: what connects to it, and their apps.
    expect([...lineage(layout, sales)].sort()).toEqual([sales, connector, trips].sort())
    // A Fabric workspace: what's deployed there, and their apps.
    const previews = lineage(layout, nodeIds.fabricPreview)
    expect(previews.has(nodeIds.copy('trips', mine)) && previews.has(nodeIds.app('notes'))).toBe(true)
    expect(previews.has(nodeIds.published('trips'))).toBe(false)
    const published = lineage(layout, nodeIds.fabricProd)
    expect(published.has(nodeIds.published('trips')) && !published.has(nodeIds.app('notes'))).toBe(true)
    // The workspace relates to everything.
    expect(lineage(layout, nodeIds.hub).size).toBe(layout.nodes.length)
  })
})
