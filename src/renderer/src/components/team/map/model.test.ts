import { describe, expect, it } from 'vitest'
import type { TeamMapRun } from '@shared/ipc'
import { AMYS, MINE, sampleMap } from './fixtures'
import {
  appHealth,
  copyHealth,
  curve,
  layoutMap,
  lineage,
  mapStats,
  nodeIds,
  previewBehind,
  previewing,
  publishedHealth,
  publishing,
  runLabel
} from './model'

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

  it('lays the workspace out as a non-overlapping tree', () => {
    const map = sampleMap()
    const layout = layoutMap(map, [run({ branch: amys })])
    expect(layout.nodes).toHaveLength(9)
    expect(layout.edges).toHaveLength(10)
    expect(layout.lanes.map((l) => l.label)).toEqual(['Workspace', 'Apps', 'Published & in progress', 'Deployed to Fabric'])
    // Nodes start below the column headings, on whole pixels.
    expect(Math.min(...layout.nodes.map((n) => n.y))).toBeGreaterThanOrEqual(40)
    expect(layout.nodes.every((n) => Number.isInteger(n.y))).toBe(true)
    const column = layout.nodes.filter((n) => n.kind === 'copy' || n.kind === 'published').sort((a, b) => a.y - b.y)
    for (let i = 1; i < column.length; i++) {
      expect(column[i].y).toBeGreaterThanOrEqual(column[i - 1].y + column[i - 1].h)
    }
    const node = (id: string): { x: number; y: number; h: number } => layout.nodes.find((n) => n.id === id)!
    expect(node(nodeIds.fabricProd).y + node(nodeIds.fabricProd).h).toBeLessThan(node(nodeIds.fabricPreview).y)
    expect(node(nodeIds.hub).x).toBeLessThan(node(nodeIds.app('trips')).x)
    const amyDeploy = layout.edges.find((e) => e.from === nodeIds.copy('trips', amys))
    expect(amyDeploy).toMatchObject({ kind: 'deploy', health: 'deploying', production: false })
    expect(amyDeploy?.d.startsWith('M ')).toBe(true)
  })

  it('connects nodes with rounded tree connectors', () => {
    const a = { id: 'a', kind: 'app' as const, x: 0, y: 0, w: 100, h: 40 }
    const level = { ...a, id: 'b', x: 200 }
    expect(curve(a, level)).toBe('M 100 20.5 L 200 20.5')
    const below = { ...a, id: 'c', x: 200, y: 100 }
    const d = curve(a, below)
    // Across to the midpoint, a rounded corner, down, another corner, across.
    expect(d).toBe('M 100 20.5 L 140.5 20.5 Q 150.5 20.5 150.5 30.5 L 150.5 110.5 Q 150.5 120.5 160.5 120.5 L 200 120.5')
  })

  it('makes room for nodes measured taller than estimated', () => {
    const map = sampleMap()
    const before = layoutMap(map, [])
    const first = nodeIds.published('trips')
    const after = layoutMap(map, [], { [first]: 400 })
    const next = (l: typeof before): number => l.nodes.find((n) => n.id === nodeIds.copy('trips', mine))!.y
    expect(next(after) - after.nodes.find((n) => n.id === first)!.y).toBeGreaterThanOrEqual(400)
    expect(next(after)).toBeGreaterThan(next(before))
  })

  it('lights up the path through a hovered node', () => {
    const layout = layoutMap(sampleMap(), [])
    const path = lineage(layout, nodeIds.copy('trips', amys))
    expect([...path].sort()).toEqual(
      [nodeIds.copy('trips', amys), nodeIds.app('trips'), nodeIds.hub, nodeIds.fabricPreview].sort()
    )
    // The workspace relates to everything, so nothing dims.
    expect(lineage(layout, nodeIds.hub).size).toBe(layout.nodes.length)
    // A Fabric workspace lights up what deploys to it.
    expect([...lineage(layout, nodeIds.fabricProd)].sort()).toEqual(
      [nodeIds.fabricProd, nodeIds.published('trips'), nodeIds.app('trips'), nodeIds.hub].sort()
    )
    const previews = lineage(layout, nodeIds.fabricPreview)
    expect(previews.has(nodeIds.copy('trips', mine)) && previews.has(nodeIds.app('notes'))).toBe(true)
    expect(previews.has(nodeIds.published('trips')) || previews.has(nodeIds.fabricProd)).toBe(false)
  })
})
