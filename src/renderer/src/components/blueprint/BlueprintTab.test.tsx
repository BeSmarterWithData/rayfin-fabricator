import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { FileNode, StudioProject, TeamManifest } from '@shared/ipc'
import { ToastProvider } from '../../toast'
import { makeProject } from '../../../test/harness'
import BlueprintTab from './BlueprintTab'
import { clearFabricInfo } from './fabricInfo'

/**
 * The Blueprint tab draws how an app is put together: its parts, what it
 * connects to, and who each connection signs in as. These tests feed it a
 * project's files through a mocked `window.api` and protect what people rely on:
 * the identities and whose credentials the app uses, the details panel and its
 * Copilot hand-offs, and moving between the Architecture and Data model views.
 */

const WS = '5d1c2a9e-1b7f-4c3d-9e21-8a64f0c2b7d1'
const WAREHOUSE = '9f3b6d10-2c4e-4a8b-b5f1-7d2e9c0a4b63'
const SPEND = 'c41e8a27-5b6d-4f90-8e13-2a7c9d5b1f04'

const FULL_YML = `name: Contoso Expenses
services:
  auth:
    enabled: true
    fabric:
      enabled: true
  data:
    enabled: true
  staticHosting:
    enabled: true
    assetAccess: protected
  functions:
    enabled: true
    auth:
      type: application
connectors:
  - name: finance-warehouse
    type: fabric-warehouse
    config: { workspaceId: ${WS}, itemId: ${WAREHOUSE} }
    auth: { type: application }
    operations: [{ name: read }]
  - name: spend-model
    type: fabric-semanticmodel
    version: '1'
    config: { workspaceId: ${WS}, itemId: ${SPEND} }
    auth: { type: delegated }
`

const SIMPLE_YML = `name: Team Notes
services:
  auth: { enabled: true, fabric: { enabled: true } }
  data: { enabled: true }
`

const SCHEMA = `import { entity, authenticated, anonymous, uuid, text } from '@microsoft/rayfin-core'
@entity()
@authenticated('*', { policy: (q, claims) => q.where('owner_id', claims.sub) })
export class Expense {
  @uuid() id!: string
  @text() owner_id!: string
}
@entity()
@anonymous('read')
export class Receipt {
  @uuid() id!: string
  @text() expense_id!: string
}
export const schema = [Expense, Receipt]
`

const FUNCTIONS = `udf.func('summarizeReport', async (ctx: RayfinContext<AppSchema, AudienceType.AzureAI>) => 1, [])`

const TREE: FileNode[] = [
  {
    name: 'rayfin',
    path: 'rayfin',
    type: 'dir',
    children: [
      {
        name: 'functions',
        path: 'rayfin/functions',
        type: 'dir',
        children: [
          {
            name: 'src',
            path: 'rayfin/functions/src',
            type: 'dir',
            children: [{ name: 'function_app.ts', path: 'rayfin/functions/src/function_app.ts', type: 'file' }]
          }
        ]
      }
    ]
  }
]

function installApi(files: Record<string, string>): { openExternal: ReturnType<typeof vi.fn> } {
  const openExternal = vi.fn(async () => {})
  ;(window as unknown as { api: unknown }).api = {
    openExternal,
    projects: {
      files: {
        read: vi.fn(async (_id: string, path: string) =>
          path in files ? { path, size: files[path].length, content: files[path] } : { path, size: 0, error: 'missing' }
        ),
        tree: vi.fn(async () => TREE)
      }
    },
    accounts: {
      fabric: vi.fn(async () => ({
        accounts: [{ id: 'a1', user: 'jordan.lee@contoso.com', active: true, shared: true }],
        sharedTokenStore: false
      }))
    },
    secrets: {
      list: vi.fn(async () => ({
        status: 'ready',
        functionsEnabled: true,
        secrets: [{ name: 'OCR_KEY', description: 'Receipt reader key', declared: true, stored: false }]
      }))
    },
    fabric: {
      listWorkspaces: vi.fn(async () => ({
        ok: true,
        workspaces: [{ id: WS, displayName: 'Finance analytics', capacityKind: 'fabric', eligible: true, sku: 'F64' }]
      })),
      listWorkspaceModels: vi.fn(async () => ({ ok: true, models: [{ id: SPEND, name: 'Spend analysis' }] })),
      semanticModelSchema: vi.fn(async () => ({
        ok: false,
        matched: false,
        error: 'offline',
        tables: [],
        columns: [],
        measures: [],
        relationships: [],
        notes: []
      }))
    }
  }
  return { openExternal }
}

const FULL_FILES = {
  'rayfin/rayfin.yml': FULL_YML,
  'rayfin/data/schema.ts': SCHEMA,
  'rayfin/functions/src/function_app.ts': FUNCTIONS
}

function renderTab(
  over: { project?: StudioProject; teamManifest?: TeamManifest; fabricUser?: string } = {}
): {
  onSendToChat: ReturnType<typeof vi.fn>
  onOpenFile: ReturnType<typeof vi.fn>
  onOpenSecrets: ReturnType<typeof vi.fn>
} {
  const onSendToChat = vi.fn()
  const onOpenFile = vi.fn()
  const onOpenSecrets = vi.fn()
  render(
    <ToastProvider>
      <BlueprintTab
        project={over.project ?? makeProject('p1', { name: 'Contoso Expenses', workspaceName: 'Contoso Apps' })}
        refreshKey={0}
        onOpenFile={onOpenFile}
        onSendToChat={onSendToChat}
        onOpenSecrets={onOpenSecrets}
        fabricUser={'fabricUser' in over ? over.fabricUser : 'avery.chen@contoso.com'}
        teamManifest={over.teamManifest}
      />
    </ToastProvider>
  )
  return { onSendToChat, onOpenFile, onOpenSecrets }
}

const node = (name: string | RegExp): HTMLElement => screen.getByRole('button', { name })
const appIdentity = (): HTMLElement => node(/^App identity:/)

beforeEach(() => {
  clearFabricInfo()
  installApi(FULL_FILES)
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  delete (window as unknown as { api?: unknown }).api
})

describe('BlueprintTab', () => {
  it('draws the app’s pieces, the identities their connections use, and what they reach', async () => {
    renderTab()
    await screen.findByText('Contoso Expenses')
    for (const part of ['Website', 'Sign-in', 'Database', 'Connectors', 'Functions']) {
      expect(node(new RegExp(`^${part}:`))).toBeTruthy()
    }
    // Each piece that reaches outside shows the identities its connections use.
    expect(node('Connectors, uses user’s identity')).toBeTruthy()
    expect(node('Connectors, uses app identity')).toBeTruthy()
    expect(node('Functions, uses app identity')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Functions, uses user’s identity' })).toBeNull()
    // Whose credentials the app uses: the Fabric account it's deployed with.
    expect(within(appIdentity()).getByText('avery.chen@contoso.com')).toBeTruthy()
    expect(within(node(/^Website:/)).getByText('Pages load after sign-in')).toBeTruthy()
    expect(within(node('Azure AI Foundry, Function connection')).getByText('Called by summarizeReport')).toBeTruthy()
    // Sources are grouped by where they live; names come from Fabric once it answers.
    await screen.findByText('Finance analytics')
    const zones = [...document.querySelectorAll<HTMLElement>('.bp-zone')]
    expect(zones.map((z) => z.querySelector('.bp-zone-title')?.textContent)).toEqual(['Finance analytics', 'Azure'])
    expect(within(zones[0]).getByRole('button', { name: 'Spend analysis, Semantic model' })).toBeTruthy()
    expect(within(zones[0]).getByText('Warehouse · Read only')).toBeTruthy()
  })

  it('names a team app’s deploy service principal as the app identity', async () => {
    const manifest = {
      schema: 1,
      name: 'Sales team',
      tenantId: 't',
      deployIdentity: { clientId: 'c1', displayName: 'Fabricator deploy - Sales team' },
      fabric: { production: { id: 'prod', name: 'Sales team' }, previews: { id: 'prev', name: 'Sales previews' } },
      settings: { requireReview: false },
      templateVersion: 3
    }
    renderTab({
      project: makeProject('p1', { name: 'Contoso Expenses', team: { workspaceId: 'w1', folder: 'expenses', worktree: 'x' } }),
      teamManifest: manifest
    })
    await screen.findByText('Contoso Expenses')
    expect(within(appIdentity()).getByText('Fabricator deploy - Sales team')).toBeTruthy()
    expect(screen.getByText('Fabric app in Sales team')).toBeTruthy()
  })

  it('names the active Fabric account when the sign-in status doesn’t', async () => {
    renderTab({ fabricUser: undefined })
    await screen.findByText('Contoso Expenses')
    await waitFor(() => expect(within(appIdentity()).getByText('jordan.lee@contoso.com')).toBeTruthy())
  })

  it('opens a source’s details, and hands a sign-in change to chat', async () => {
    const { onSendToChat } = renderTab()
    await screen.findByText('Contoso Expenses')
    fireEvent.click(node('Finance warehouse, Warehouse'))
    const panel = screen.getByRole('complementary', { name: 'Finance warehouse details' })
    expect(within(panel).getByText('Application: runs as avery.chen@contoso.com, the same for everyone.')).toBeTruthy()
    expect(within(panel).getByText(WAREHOUSE)).toBeTruthy()
    fireEvent.click(within(panel).getByRole('button', { name: /Use user’s identity/ }))
    expect(onSendToChat).toHaveBeenCalledWith(
      'Use the user’s identity for finance-warehouse',
      expect.stringContaining('`auth.type: delegated`'),
      undefined
    )
    // Escape closes it.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('explains whose credentials the app uses and what to grant them', async () => {
    renderTab()
    await screen.findByText('Contoso Expenses')
    fireEvent.click(appIdentity())
    const panel = screen.getByRole('complementary', { name: 'App identity details' })
    expect(within(panel).getByText('Your Fabric account, which deploys this app')).toBeTruthy()
    expect(within(panel).getByText('Grant it access to')).toBeTruthy()
    expect(within(panel).getByText('Finance warehouse')).toBeTruthy()
    expect(within(panel).getByText('Azure AI Foundry')).toBeTruthy()
    expect(within(panel).queryByText('Spend model')).toBeNull()
  })

  it('narrows a piece’s port to what that piece reaches with that identity', async () => {
    renderTab()
    await screen.findByText('Contoso Expenses')
    fireEvent.click(node('Connectors, uses app identity'))
    const panel = screen.getByRole('complementary', { name: 'Uses app identity details' })
    expect(within(panel).getByText('Connectors')).toBeTruthy()
    expect(within(panel).getByText('Finance warehouse')).toBeTruthy()
    expect(within(panel).queryByText('Azure AI Foundry')).toBeNull()
  })

  it('shows APIs reached with a key, and offers to move a key out of the code', async () => {
    installApi({
      ...FULL_FILES,
      'rayfin/functions/src/function_app.ts': `export const REDDIT_CLIENT_SECRET = 'k3yValue9a8b7c6d5e4f'
udf.func('posts', async () => fetch('https://oauth.reddit.com/r/all'), [])`
    })
    const { onSendToChat } = renderTab()
    await screen.findByText('Contoso Expenses')
    expect(within(node(/^Functions:/)).getByTitle(/REDDIT_CLIENT_SECRET/)).toBeTruthy()
    expect(node('Reddit, reddit.com')).toBeTruthy()
    fireEvent.click(node('Functions, uses a key'))
    const panel = screen.getByRole('complementary', { name: 'Uses a key details' })
    expect(within(panel).getByRole('alert').textContent).toContain('REDDIT_CLIENT_SECRET')
    fireEvent.click(within(panel).getByRole('button', { name: /Move keys into secrets/ }))
    expect(onSendToChat).toHaveBeenCalledWith(
      'Move REDDIT_CLIENT_SECRET into a secret',
      expect.stringContaining('ctx.Secrets'),
      undefined
    )
  })

  it('shows the app’s secrets, which have values, and opens Code → Secrets', async () => {
    installApi({
      ...FULL_FILES,
      'rayfin/rayfin.yml': `${FULL_YML}secrets:
  - name: OCR_KEY
    description: Receipt reader key
`,
      'rayfin/functions/src/function_app.ts': `udf.func('readReceipt', async (ctx) =>
  fetch('https://api.mindee.net/v1/x', { headers: { Authorization: ctx.Secrets.OCR_KEY } }), [])`
    })
    const { onOpenSecrets } = renderTab()
    await screen.findByText('Contoso Expenses')
    const part = node(/^Secrets:/)
    expect(within(part).getByText('OCR_KEY')).toBeTruthy()
    fireEvent.click(part)
    const panel = screen.getByRole('complementary', { name: 'Secrets details' })
    expect(within(panel).getByText('Read by readReceipt')).toBeTruthy()
    // The deployed app has no value for it, and a function reads it.
    expect(await within(panel).findByText('No value')).toBeTruthy()
    expect(within(panel).getByText(/no value for/).closest('.bp-issue')!.textContent).toContain('OCR_KEY')
    // The API called alongside it.
    expect(within(panel).getByText('Mindee')).toBeTruthy()
    fireEvent.click(within(panel).getByRole('button', { name: /Manage secrets/ }))
    expect(onOpenSecrets).toHaveBeenCalled()
  })

  it('jumps from a table to the Data model view, focused on it', async () => {
    renderTab()
    await screen.findByText('Contoso Expenses')
    fireEvent.click(node(/^Database:/))
    const panel = screen.getByRole('complementary', { name: 'Database details' })
    expect(within(panel).getByText('1 table is readable without signing in.')).toBeTruthy()
    fireEvent.click(within(panel).getByRole('button', { name: /^Expense/ }))
    await screen.findByText(/Focusing Expense/)
    expect(screen.getByRole('tab', { name: /Data model/ }).getAttribute('aria-selected')).toBe('true')
    expect(localStorage.getItem('rayfin.model.view.p1')).toBe('data')
  })

  it('offers to connect data when the app reaches nothing outside, and has no Semantic model view', async () => {
    installApi({ 'rayfin/rayfin.yml': SIMPLE_YML, 'rayfin/data/schema.ts': SCHEMA })
    const { onSendToChat } = renderTab({ project: makeProject('p2', { name: 'Team Notes' }) })
    await screen.findByText('No outside data yet')
    expect(screen.queryByText('Signs in as')).toBeNull()
    expect(screen.queryByRole('tab', { name: /Semantic model/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Connect data with Copilot' }))
    expect(onSendToChat).toHaveBeenCalledWith('Connect data from Fabric', expect.stringContaining('rayfin connector add'), true)
  })

  it('remembers the chosen view for the project', async () => {
    localStorage.setItem('rayfin.model.view.p1', 'data')
    renderTab()
    expect(screen.getByRole('tab', { name: /Data model/ }).getAttribute('aria-selected')).toBe('true')
    await screen.findByText(/2 entities/)
    fireEvent.click(screen.getByRole('tab', { name: /Architecture/ }))
    expect(localStorage.getItem('rayfin.model.view.p1')).toBe('architecture')
    await screen.findByText('Contoso Expenses')
  })

  it('explains an unreadable rayfin.yml instead of drawing nothing', async () => {
    installApi({ 'rayfin/rayfin.yml': 'services: [' })
    const { onOpenFile } = renderTab()
    await screen.findByText('Couldn’t draw the app')
    fireEvent.click(screen.getByRole('button', { name: 'Open rayfin.yml' }))
    expect(onOpenFile).toHaveBeenCalledWith('rayfin/rayfin.yml')
  })
})
