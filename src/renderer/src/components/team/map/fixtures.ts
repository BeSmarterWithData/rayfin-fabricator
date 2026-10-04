import type { TeamMap, TeamMapRun, TeamResourceRequest, TeamResourceSource, TeamWorkspace } from '@shared/ipc'

/** Sample workspace-map data for tests and visual checks. */
export const MINE = 'fabricator/me/trips-20261003-225801'
export const AMYS = 'fabricator/amy/trips-20261003-120000'

export const sampleWorkspace: TeamWorkspace = {
  id: 'w1',
  name: 'Sales team',
  repo: 'octo/sales-team',
  defaultBranch: 'main',
  dir: 'C:/team',
  role: 'owner',
  addedAt: '2026-10-01T00:00:00Z',
  manifest: {
    schema: 1,
    name: 'Sales team',
    tenantId: 't',
    deployIdentity: { clientId: 'c', displayName: 'Fabricator deploy - Sales team' },
    fabric: { production: { id: 'prod-ws', name: 'Sales team' }, previews: { id: 'preview-ws', name: 'Sales team previews' } },
    settings: { requireReview: false },
    templateVersion: 3
  }
}

export function sampleMap(): TeamMap {
  return {
    ok: true,
    viewer: 'me',
    workspace: sampleWorkspace,
    fetchedAt: '2026-10-03T23:10:00Z',
    members: [
      { login: 'me', role: 'owner' },
      { login: 'amy', role: 'member' }
    ],
    runs: [],
    apps: [
      {
        folder: 'trips',
        name: 'Trip Logger',
        published: true,
        projectId: 'p1',
        production: {
          environment: 'production/trips',
          state: 'success',
          url: 'https://trips.app',
          sha: 'main1aaaaaaa',
          updatedAt: '2026-10-03T20:00:00Z'
        },
        copies: [
          {
            branch: MINE,
            author: 'me',
            mine: true,
            pr: {
              number: 3,
              url: 'https://github.com/o/r/pull/3',
              draft: true,
              state: 'open',
              title: 'Trip Logger: add a map of every trip',
              author: 'me',
              headSha: 'h3',
              approvals: 0
            },
            additions: 120,
            deletions: 8,
            changedFiles: 5,
            commits: 2,
            localEdits: true,
            behind: 1,
            updatedAt: '2026-10-03T23:05:00Z',
            preview: { environment: 'preview/trips/me', state: 'success', url: 'https://me.app', sha: 'h2' },
            files: [
              { path: 'trips/src/Map.tsx', change: 'added', additions: 100, deletions: 0 },
              { path: 'trips/src/App.tsx', change: 'modified', additions: 20, deletions: 8 }
            ]
          },
          {
            branch: AMYS,
            author: 'amy',
            mine: false,
            pr: {
              number: 4,
              url: 'https://github.com/o/r/pull/4',
              draft: false,
              state: 'open',
              title: 'Trip Logger: export trips to CSV',
              author: 'amy',
              headSha: 'h4',
              approvals: 0
            },
            additions: 10,
            deletions: 2,
            changedFiles: 1,
            commits: 1,
            localEdits: false,
            review: 'REVIEW_REQUIRED',
            updatedAt: '2026-10-03T22:00:00Z',
            preview: { environment: 'preview/trips/amy', state: 'failure', sha: 'h4' },
            files: [{ path: 'trips/src/export.ts', change: 'added', additions: 10, deletions: 2 }]
          }
        ]
      },
      {
        folder: 'notes',
        name: 'Notes',
        published: false,
        copies: [
          {
            branch: 'fabricator/me/notes-20261003-230000',
            author: 'me',
            mine: true,
            additions: 3000,
            deletions: 0,
            changedFiles: 40,
            commits: 1,
            localEdits: false,
            files: []
          }
        ]
      }
    ]
  }
}

/** A preview run deploying Amy's copy of Trip Logger. */
export function sampleRun(): TeamMapRun {
  return {
    id: 77,
    kind: 'preview',
    status: 'in_progress',
    url: 'https://github.com/o/r/actions/runs/77',
    sha: 'h4',
    branch: AMYS,
    title: 'Trip Logger: export trips to CSV',
    actor: 'amy',
    prNumber: 4,
    startedAt: '2026-10-03T23:09:00Z',
    jobs: [
      { name: 'Plan', status: 'completed', conclusion: 'success', steps: [] },
      {
        name: 'Preview trips',
        folder: 'trips',
        status: 'in_progress',
        steps: [
          { name: 'Run actions/checkout@v7', status: 'completed', conclusion: 'success' },
          { name: 'Install dependencies', status: 'completed', conclusion: 'success' },
          { name: 'Deploy with Rayfin', status: 'in_progress' },
          { name: 'Record the deployment', status: 'queued' }
        ]
      }
    ]
  }
}

/* Config files for the data view: published Trip Logger, and your copy of it. */

export const SALES_ITEM = '0f6c2a1e-1111-4222-8333-944455556666'
export const INVENTORY_ITEM = '7d1b3c2f-2222-4333-8444-a55566667777'

const tripsYml = (connectors: string): string => `id: trips
name: Trip Logger
services:
  auth:
    enabled: true
  data:
    enabled: true
  storage:
    enabled: false
  functions:
    enabled: true
connectors:
${connectors}`

const salesConnector = `  sales:
    connector: fabric-semanticmodel
    config:
      workspaceId: bi-ws
      itemId: ${SALES_ITEM}
    auth:
      type: delegated
    version: "1"
    operations:
      - name: executeQuery
`

const inventoryConnector = `  inventory:
    connector: fabric-warehouse
    config:
      workspaceId: ops-ws
      itemId: ${INVENTORY_ITEM}
    auth:
      type: delegated
    operations:
      - name: read
      - name: create
`

const schemaOf = (names: string[]): string => `${names.map((n) => `import { ${n} } from './${n}.js'`).join('\n')}

export type AppSchema = {
${names.map((n) => `  ${n}: ${n}`).join('\n')}
}

export const schema = [${names.join(', ')}]
`

const TRIP = `import { entity, authenticated, uuid, text, date } from '@microsoft/rayfin-core'

@entity()
@authenticated('*')
export class Trip {
  @uuid() id!: string
  @text({ max: 200 }) destination!: string
  @date() startDate!: Date
}
`

const RECEIPT = `import { entity, authenticated, uuid, text, blob } from '@microsoft/rayfin-core'

@entity()
@authenticated('*')
export class Receipt {
  @uuid() id!: string
  @text() trip_id!: string
  @blob() photo!: string
}
`

const FUNCTIONS = `import { UserDataFunctions, AudienceType, type RayfinContext } from '@microsoft/fabric-user-data-functions'

const udf = new UserDataFunctions()

udf.func(
  'summarize',
  async (ctx: RayfinContext<AppSchema, AudienceType.AzureAI>): Promise<string> => ctx.Tokens.AzureAI,
  []
)
// udf.func('retired', async () => 1, [])
`

/** The published Trip Logger's config files. */
export const publishedTripsFiles: Record<string, string> = {
  'rayfin/rayfin.yml': tripsYml(salesConnector),
  'rayfin/data/schema.ts': schemaOf(['Trip']),
  'rayfin/data/Trip.ts': TRIP,
  'rayfin/functions/src/function_app.ts': FUNCTIONS
}

/** Your copy: adds a Receipt table (with photos) and an inventory connector. */
export const myTripsFiles: Record<string, string> = {
  ...publishedTripsFiles,
  'rayfin/rayfin.yml': tripsYml(inventoryConnector + salesConnector),
  'rayfin/data/schema.ts': schemaOf(['Trip', 'Receipt']),
  'rayfin/data/Receipt.ts': RECEIPT
}

/** Answers `team.resources` for {@link sampleMap}. */
export function sampleResources(requests: TeamResourceRequest[]): TeamResourceSource[] {
  return requests.map((r) => {
    const files = r.folder === 'trips' ? (r.local ? myTripsFiles : publishedTripsFiles) : {}
    return { folder: r.folder, branch: r.branch, local: Boolean(r.local), ok: true, files, truncated: false }
  })
}
