import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { TeamResourceRequest } from '@shared/ipc'
import { OverlayProvider, usePreviewSuppressed } from '../../../overlay'
import TeamMapView from './TeamMapView'
import { parseNodeId, parsePatch } from './Inspector'
import { AMYS, sampleMap, sampleResources, sampleRun, sampleWorkspace } from './fixtures'
import { nodeIds } from './model'

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

function Probe(): JSX.Element {
  return <span data-testid="suppressed">{String(usePreviewSuppressed())}</span>
}

type Mock = ReturnType<typeof vi.fn>

function installApi(): Record<
  'diff' | 'openProject' | 'members' | 'health' | 'setRequireReview' | 'leave' | 'removeProject' | 'map' | 'resources',
  Mock
> {
  const diff = vi.fn(() =>
    Promise.resolve({
      ok: true,
      truncated: false,
      files: [
        {
          path: 'trips/src/export.ts',
          change: 'added',
          additions: 2,
          deletions: 1,
          truncated: false,
          patch: '@@ -1,2 +1,3 @@\n-old line\n+new line\n+another\n kept'
        }
      ]
    })
  )
  const openProject = vi.fn(() => Promise.resolve({ ok: true, project: { id: 'p1', name: 'Trip Logger', path: 'x', addedAt: '' } }))
  const members = vi.fn(() =>
    Promise.resolve({
      ok: true,
      canManage: true,
      members: [
        { login: 'me', role: 'owner', pending: false },
        { login: 'amy', role: 'member', pending: false },
        { login: 'bo', role: 'member', pending: true, invitationId: 7 }
      ]
    })
  )
  const health = vi.fn(() =>
    Promise.resolve({ ok: true, items: [{ id: 'pipeline', label: 'The pipeline is up to date', state: 'ok', repairable: false }] })
  )
  const setRequireReview = vi.fn(() => Promise.resolve({ ok: true }))
  const leave = vi.fn(() => Promise.resolve())
  const removeProject = vi.fn(() => Promise.resolve({ ok: true }))
  const map = vi.fn(() => Promise.resolve(sampleMap()))
  const resources = vi.fn((_workspaceId: string, requests: TeamResourceRequest[]) =>
    Promise.resolve({ ok: true, sources: sampleResources(requests) })
  )
  ;(window as unknown as { api: unknown }).api = {
    openExternal: vi.fn(),
    team: {
      diff,
      openProject,
      members,
      health,
      fabricAccess: vi.fn(() => Promise.resolve({ ok: true, people: [] })),
      setRequireReview,
      leave,
      removeProject,
      map,
      resources,
      onProgress: vi.fn(() => () => {})
    }
  }
  return { diff, openProject, members, health, setRequireReview, leave, removeProject, map, resources }
}

function renderMap(
  onOpened = vi.fn(),
  extra: { manage?: boolean; onClose?: () => void; onChanged?: () => void } = {}
): void {
  const map = sampleMap()
  map.runs = [sampleRun()]
  render(
    <OverlayProvider>
      <Probe />
      <TeamMapView
        workspace={sampleWorkspace}
        initialMap={map}
        onClose={extra.onClose ?? vi.fn()}
        onOpened={onOpened}
        manage={extra.manage}
        onChanged={extra.onChanged}
      />
    </OverlayProvider>
  )
}

describe('TeamMapView', () => {
  it('draws the workspace: apps, working copies, published apps and Fabric', () => {
    installApi()
    renderMap()
    expect(screen.getByTestId('suppressed').textContent).toBe('true')
    const region = screen.getByRole('region', { name: 'Sales team overview' })
    expect(within(region).getByText('Workspace')).toBeTruthy()
    expect(within(region).getByText('Deployed to Fabric')).toBeTruthy()
    expect(within(region).getAllByText('Trip Logger').length).toBeGreaterThan(0)
    expect(within(region).getByText('Notes')).toBeTruthy()
    expect(within(region).getByText('Not published yet')).toBeTruthy()
    expect(within(region).getByText('Published apps')).toBeTruthy()
    expect(within(region).getByText('Previews')).toBeTruthy()
    expect(within(region).getByLabelText('Summary').textContent).toContain('2 apps')
    // Amy's preview is deploying: her copy shows the step in progress, the
    // header counts it, and the sidebar lists the run.
    expect(within(region).getAllByText('Deploy with Rayfin').length).toBeGreaterThan(0)
    expect(within(region).getByText('1 deploying')).toBeTruthy()
    const activity = within(region).getByRole('complementary', { name: 'Pipeline activity' })
    expect(within(activity).getByText('Preview of Trip Logger')).toBeTruthy()
    // Its connector to Fabric shows the deploy flowing.
    expect(document.querySelectorAll('.tmap-edge--deploying .tmap-edge-flow').length).toBe(1)
  })

  it('shows a working copy’s changes in the inspector', async () => {
    const { diff } = installApi()
    renderMap()
    const amy = screen.getByText('export trips to CSV').closest('.tmap-node') as HTMLElement
    await act(async () => {
      fireEvent.click(amy)
    })
    const details = screen.getByRole('complementary', { name: 'Details' })
    expect(within(details).getByText('amy’s working copy')).toBeTruthy()
    expect(diff).toHaveBeenCalledWith('w1', 'trips', 4)
    const file = await within(details).findByRole('button', { name: /export\.ts/ })
    fireEvent.click(file)
    expect(within(details).getByText('new line')).toBeTruthy()
    expect(within(details).getByText('old line')).toBeTruthy()
  })

  it('reads your own copy from this computer, unsaved edits included', async () => {
    const { diff } = installApi()
    renderMap()
    const mine = screen.getByText('add a map of every trip').closest('.tmap-node') as HTMLElement
    await act(async () => {
      fireEvent.click(mine)
    })
    expect(diff).toHaveBeenCalledWith('w1', 'trips', undefined)
    expect(await screen.findByText('Includes unsaved edits')).toBeTruthy()
  })

  it('opens an app from its node', async () => {
    const { openProject } = installApi()
    const onOpened = vi.fn()
    renderMap(onOpened)
    const appNode = document.querySelector('.tmap-node--app') as HTMLElement
    await act(async () => {
      fireEvent.click(within(appNode).getByRole('button', { name: 'Open' }))
    })
    expect(openProject).toHaveBeenCalledWith('w1', 'trips')
    expect(onOpened).toHaveBeenCalled()
  })

  it('manages the workspace in its sidebar: members, then settings', async () => {
    const api = installApi()
    const onChanged = vi.fn()
    await act(async () => {
      renderMap(vi.fn(), { manage: true, onChanged })
    })
    const panel = screen.getByRole('complementary', { name: 'Workspace' })
    expect(api.members).toHaveBeenCalledWith('w1')
    expect(within(panel).getByText('amy')).toBeTruthy()
    expect(within(panel).getByText('Invited')).toBeTruthy()
    expect(within(panel).getByRole('button', { name: 'Send invitation' })).toBeTruthy()

    await act(async () => {
      fireEvent.click(within(panel).getByRole('tab', { name: 'Settings' }))
    })
    expect(api.health).toHaveBeenCalledWith('w1')
    expect(within(panel).getByText('The pipeline is up to date')).toBeTruthy()
    await act(async () => {
      fireEvent.click(within(panel).getByRole('checkbox', { name: 'Require a review before publishing' }))
    })
    expect(api.setRequireReview).toHaveBeenCalledWith('w1', true)
    // A change reloads the overview and tells the caller.
    expect(api.map).toHaveBeenCalledWith('w1')
    expect(onChanged).toHaveBeenCalled()
  })

  it('keeps the sidebar open when Esc closes a confirmation on top of it', async () => {
    const api = installApi()
    const onClose = vi.fn()
    const onChanged = vi.fn()
    await act(async () => {
      renderMap(vi.fn(), { manage: true, onClose, onChanged })
    })
    const panel = screen.getByRole('complementary', { name: 'Workspace' })
    await act(async () => {
      fireEvent.click(within(panel).getByRole('tab', { name: 'Settings' }))
    })
    fireEvent.click(within(panel).getByRole('button', { name: 'Leave on this computer' }))
    expect(screen.getByRole('dialog', { name: 'Leave Sales team?' })).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('complementary', { name: 'Workspace' })).toBeTruthy()

    fireEvent.click(within(panel).getByRole('button', { name: 'Leave on this computer' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Leave' }))
    })
    expect(api.leave).toHaveBeenCalledWith('w1')
    expect(onChanged).toHaveBeenCalled()

    // Without a dialog, Esc closes the sidebar, then the overview.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('complementary', { name: 'Workspace' })).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('opens the workspace sidebar from the workspace node', async () => {
    installApi()
    await act(async () => {
      renderMap()
    })
    const hub = document.querySelector('.tmap-node--hub') as HTMLElement
    await act(async () => {
      fireEvent.click(hub)
    })
    expect(screen.getByRole('complementary', { name: 'Workspace' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Manage' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('lets an owner remove an app from its details', async () => {
    const api = installApi()
    const onChanged = vi.fn()
    await act(async () => {
      renderMap(vi.fn(), { onChanged })
    })
    const appNode = document.querySelector('.tmap-node--app') as HTMLElement
    await act(async () => {
      fireEvent.click(appNode)
    })
    const details = screen.getByRole('complementary', { name: 'Details' })
    fireEvent.click(within(details).getByRole('button', { name: 'Remove from workspace…' }))
    const dialog = screen.getByRole('dialog', { name: 'Remove Trip Logger?' })
    fireEvent.click(within(dialog).getByRole('checkbox'))
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    })
    expect(api.removeProject).toHaveBeenCalledWith('w1', 'trips', true)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('complementary', { name: 'Details' })).toBeNull()
    expect(onChanged).toHaveBeenCalled()
  })

  it('shows each app’s data and connections, and what your copy adds', async () => {
    const api = installApi()
    await act(async () => {
      renderMap()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: /Data & connections/ }))
    })
    // The published app, and your copy here (it has unsaved edits).
    expect(api.resources).toHaveBeenCalledWith('w1', [{ folder: 'trips' }, { folder: 'trips', local: true }])
    const region = screen.getByRole('region', { name: 'Sales team overview' })
    expect(within(region).getByText('Inside each app')).toBeTruthy()
    expect(within(region).queryByText('Published & in progress')).toBeNull()
    expect(within(region).getByLabelText('Summary').textContent).toContain('1 database')
    expect(within(region).getByText('Database')).toBeTruthy()
    expect(within(region).getByText('No database or connections')).toBeTruthy()
    // Your copy's additions show on the nodes and in the sidebar.
    expect(within(region).getAllByText('Your copy adds Receipt')).toHaveLength(2)
    expect(within(region).getAllByText('Your copy connects to inventory')).toHaveLength(2)
    const inventory = within(region).getByText('inventory').closest('.tmap-node') as HTMLElement
    expect(inventory.className).toContain('tmap-node--draft')

    // A connector's details, then the semantic model it reads.
    await act(async () => {
      fireEvent.click(within(region).getByText('sales').closest('.tmap-node') as HTMLElement)
    })
    const details = screen.getByRole('complementary', { name: 'Details' })
    expect(within(details).getByText('Semantic model connector')).toBeTruthy()
    expect(within(details).getByText('Runs queries')).toBeTruthy()
    expect(within(details).getByText('The person using the app')).toBeTruthy()
    expect(within(details).getByRole('button', { name: /Open its workspace in Fabric/ })).toBeTruthy()
    fireEvent.click(within(details).getByRole('button', { name: /^Sales/ }))
    const source = screen.getByRole('complementary', { name: 'Details' })
    expect(within(source).getByText('In Microsoft Fabric')).toBeTruthy()
    expect(within(source).getByRole('button', { name: /Trip Logger/ })).toBeTruthy()

    // Back to everyone's changes.
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: /Changes/ }))
    })
    expect(within(region).getByText('Published & in progress')).toBeTruthy()
    expect(within(region).queryByText('Inside each app')).toBeNull()
  })
})

describe('map inspector helpers', () => {
  it('splits node ids, keeping branch names whole', () => {
    expect(parseNodeId(nodeIds.copy('trips', AMYS))).toEqual({ kind: 'copy', folder: 'trips', branch: AMYS })
    expect(parseNodeId(nodeIds.app('trips'))).toEqual({ kind: 'app', folder: 'trips', branch: undefined })
    expect(parseNodeId('fabric:prod')).toEqual({ kind: 'fabric:prod' })
  })

  it('numbers patch lines from their hunk headers', () => {
    const rows = parsePatch('@@ -10,2 +10,3 @@ section\n-a\n+b\n+c\n d\n\\ No newline at end of file')
    expect(rows.map((r) => [r.kind, r.old, r.new])).toEqual([
      ['hunk', undefined, undefined],
      ['del', 10, undefined],
      ['add', undefined, 10],
      ['add', undefined, 11],
      ['ctx', 11, 12],
      ['note', undefined, undefined]
    ])
  })
})
