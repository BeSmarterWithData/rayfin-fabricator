import { describe, expect, it } from 'vitest'
import { AMYS, INVENTORY_ITEM, SALES_ITEM, myTripsFiles, publishedTripsFiles, sampleMap, sampleResources } from './fixtures'
import { layoutData, lineage, nodeIds } from './model'
import {
  buildResourceView,
  connectorAbility,
  dataIds,
  dataStats,
  humanize,
  parseAppConfig,
  parseSources,
  resourceRequests,
  type ResourceView
} from './resources'

describe('parseAppConfig', () => {
  it('reads the database, file storage, functions and connectors', async () => {
    const config = await parseAppConfig(myTripsFiles)
    expect(config.found).toBe(true)
    expect(config.database?.tables.map((t) => t.name)).toEqual(['Trip', 'Receipt'])
    expect(config.database?.tables[0]).toMatchObject({ fields: 3, access: 'authenticated' })
    // A @blob field means the app keeps uploaded files.
    expect(config.files).toBe(true)
    // Commented-out functions don't count.
    expect(config.functions).toEqual({ names: ['summarize'], audiences: ['AzureAI'] })
    expect(config.connectors).toEqual([
      {
        name: 'inventory',
        type: 'fabric-warehouse',
        workspaceId: 'ops-ws',
        itemId: INVENTORY_ITEM,
        database: undefined,
        operations: ['read', 'create'],
        auth: 'delegated'
      },
      {
        name: 'sales',
        type: 'fabric-semanticmodel',
        workspaceId: 'bi-ws',
        itemId: SALES_ITEM,
        database: undefined,
        operations: ['executeQuery'],
        auth: 'delegated'
      }
    ])
    expect(connectorAbility(config.connectors[0])).toBe('Reads and writes')
    expect(connectorAbility(config.connectors[1])).toBe('Runs queries')
  })

  it('treats switched-off services and missing files as nothing to show', async () => {
    const config = await parseAppConfig({
      'rayfin/rayfin.yml':
        'services:\n  data:\n    enabled: false\n  functions:\n    enabled: false\nconnectors:\n  - name: logs\n    type: kusto\n    config:\n      database: telemetry\n',
      'rayfin/data/schema.ts': 'export const schema = []\n'
    })
    expect(config).toMatchObject({ found: true, database: null, files: false, functions: null })
    // Connectors can also be a list.
    expect(config.connectors).toMatchObject([{ name: 'logs', type: 'kusto', database: 'telemetry' }])
    expect((await parseAppConfig({})).found).toBe(false)
    expect((await parseAppConfig({ 'rayfin/rayfin.yml': ': not yaml: [' })).connectors).toEqual([])
    expect(humanize('coffee-shop_sales')).toBe('Coffee shop sales')
  })
})

describe('resourceRequests', () => {
  it('reads published apps, and only the working copies that change their config', () => {
    const map = sampleMap()
    // Your copy has unsaved edits (read from this computer); Amy's only touches src/.
    expect(resourceRequests(map)).toEqual([{ folder: 'trips' }, { folder: 'trips', local: true }])
    map.apps[0].copies[1].files.push({ path: 'trips/rayfin/rayfin.yml', change: 'modified', additions: 4, deletions: 0 })
    expect(resourceRequests(map)).toContainEqual({ folder: 'trips', branch: AMYS })
    // A file list GitHub cut short might hide a config change.
    map.apps[0].copies[0].localEdits = false
    map.apps[0].copies[0].files = []
    map.apps[0].copies[0].changedFiles = 0
    expect(resourceRequests(map)).not.toContainEqual({ folder: 'trips', local: true })
    map.apps[0].copies[0].changedFiles = 200
    expect(resourceRequests(map)).toContainEqual({ folder: 'trips', local: true })
  })
})

describe('buildResourceView', () => {
  async function view(): Promise<ResourceView> {
    const map = sampleMap()
    return buildResourceView(map, await parseSources(sampleResources(resourceRequests(map))))
  }

  it('shows what the published app uses, and what your copy adds', async () => {
    const { apps, sources } = await view()
    const trips = apps.trips.items
    expect(trips.map((i) => [i.title, i.published])).toEqual([
      ['Database', true],
      ['File storage', false],
      ['Functions', true],
      ['inventory', false],
      ['sales', true]
    ])
    const changes = (title: string): string[] =>
      trips.find((i) => i.title === title)?.changes.map((c) => `${c.mine ? 'mine' : c.author}: ${c.kind} ${c.what}`) ?? []
    expect(changes('Database')).toEqual(['mine: change adds Receipt'])
    expect(changes('File storage')).toEqual(['mine: add adds file storage'])
    expect(changes('inventory')).toEqual(['mine: add connects to inventory'])
    expect(changes('sales')).toEqual([])
    expect(changes('Functions')).toEqual([])
    // The sources: two Fabric items and the service the functions reach.
    expect(sources.map((s) => [s.title, s.detail, s.published])).toEqual([
      ['Azure AI', 'Reached by functions', true],
      ['Inventory', 'Warehouse', false],
      ['Sales', 'Semantic model', true]
    ])
    expect(apps.notes.items).toEqual([])
    expect(dataStats({ apps, sources })).toEqual({ databases: 1, connected: 3, changing: 3 })
  })

  it('notices what a copy removes, and dedupes a source two apps use', async () => {
    const map = sampleMap()
    map.apps[1].published = true
    // Your copy drops the connector and the functions.
    const withoutConnectors = {
      'rayfin/rayfin.yml': 'services:\n  data:\n    enabled: true\n',
      'rayfin/data/schema.ts': publishedTripsFiles['rayfin/data/schema.ts'],
      'rayfin/data/Trip.ts': publishedTripsFiles['rayfin/data/Trip.ts']
    }
    const view = buildResourceView(
      map,
      await parseSources([
        { folder: 'trips', local: false, ok: true, files: publishedTripsFiles, truncated: false },
        { folder: 'trips', local: true, ok: true, files: withoutConnectors, truncated: false },
        { folder: 'notes', local: false, ok: true, files: publishedTripsFiles, truncated: false }
      ])
    )
    const sales = view.apps.trips.items.find((i) => i.title === 'sales')
    expect(sales?.changes.map((c) => c.what)).toEqual(['disconnects sales'])
    expect(view.apps.trips.items.find((i) => i.title === 'Functions')?.changes.map((c) => c.what)).toEqual([
      'removes the functions'
    ])
    const shared = view.sources.find((s) => s.itemId === SALES_ITEM)
    expect(shared?.users).toEqual([dataIds.item('trips', 'connector:sales'), dataIds.item('notes', 'connector:sales')])
    // An app that couldn't be read says so.
    const broken = buildResourceView(map, [{ folder: 'trips', local: false, ok: false, error: 'Nope', truncated: false }])
    expect(broken.apps.trips).toEqual({ items: [], error: 'Nope' })
  })
})

describe('layoutData', () => {
  it('draws each app’s resources beside it and a shared source once, without overlaps', async () => {
    const map = sampleMap()
    map.apps[1].published = true
    const view = buildResourceView(
      map,
      await parseSources([
        { folder: 'trips', local: false, ok: true, files: publishedTripsFiles, truncated: false },
        { folder: 'notes', local: false, ok: true, files: publishedTripsFiles, truncated: false }
      ])
    )
    const layout = layoutData(map, view)
    const sources = layout.nodes.filter((n) => n.kind === 'source')
    expect(sources.map((n) => n.id).sort()).toEqual([
      dataIds.source(`item:${SALES_ITEM}`),
      dataIds.source('service:AzureAI')
    ])
    // Two apps link to the one shared semantic model.
    const intoSales = layout.edges.filter((e) => e.to === dataIds.source(`item:${SALES_ITEM}`))
    expect(intoSales.map((e) => e.from)).toEqual([
      dataIds.item('trips', 'connector:sales'),
      dataIds.item('notes', 'connector:sales')
    ])
    const sorted = [...sources].sort((a, b) => a.y - b.y)
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].y).toBeGreaterThanOrEqual(sorted[i - 1].y + sorted[i - 1].h)
    expect(layout.lanes.map((l) => l.label)).toEqual(['Workspace', 'Apps', 'Inside each app', 'Connected to'])
    // Hovering the source lights up both apps that use it.
    const lit = lineage(layout, dataIds.source(`item:${SALES_ITEM}`))
    expect(lit.has(nodeIds.app('trips')) && lit.has(nodeIds.app('notes'))).toBe(true)
  })

  it('stands in a placeholder for an app with nothing to show, and dashes what isn’t published', async () => {
    const map = sampleMap()
    const loading = layoutData(map, null)
    expect(loading.nodes.filter((n) => n.kind === 'resource-empty').map((n) => n.id)).toEqual([
      dataIds.empty('trips'),
      dataIds.empty('notes')
    ])
    expect(loading.lanes.map((l) => l.label)).not.toContain('Connected to')
    const view = buildResourceView(map, await parseSources(sampleResources(resourceRequests(map))))
    const layout = layoutData(map, view)
    expect(layout.nodes.find((n) => n.id === dataIds.item('trips', 'connector:inventory'))?.draft).toBe(true)
    expect(layout.nodes.find((n) => n.id === dataIds.item('trips', 'connector:sales'))?.draft).toBeUndefined()
    expect(layout.edges.find((e) => e.to === dataIds.source(`item:${INVENTORY_ITEM}`))?.draft).toBe(true)
  })
})
