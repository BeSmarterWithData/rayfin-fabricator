import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { TeamAbandonPlan, TeamActionResult, TeamProgressEvent, TeamWorkspace } from '@shared/ipc'
import { OverlayProvider } from '../../overlay'
import AbandonSetupModal, { abandonSteps } from './AbandonSetupModal'
import CreateTeamWorkspaceModal from './CreateTeamWorkspaceModal'
import TeamWorkspaceCard from './TeamWorkspaceCard'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete (window as unknown as { api?: unknown }).api
})

const workspace: TeamWorkspace = {
  id: 'w1',
  name: 'Sales',
  repo: 'octo/sales',
  defaultBranch: 'main',
  dir: 'C:\\Projects\\sales',
  role: 'owner',
  addedAt: '2026-10-01T00:00:00Z',
  account: 'octo',
  setup: {
    request: { name: 'Sales', owner: 'octo', ownerIsOrg: false, capacityId: 'cap' },
    completed: ['github', 'fabric', 'identity'],
    appId: 'deploy-client',
    productionWorkspaceId: 'p',
    previewsWorkspaceId: 'v',
    done: false
  }
}

const plan: TeamAbandonPlan = {
  ok: true,
  items: [
    { kind: 'identity', id: 'deploy-client', name: 'Fabricator deploy - Sales' },
    { kind: 'fabric', id: 'p', name: 'Sales', url: 'https://app.fabric.microsoft.com/groups/p/' },
    { kind: 'fabric', id: 'v', name: 'Sales previews', url: 'https://app.fabric.microsoft.com/groups/v/' },
    { kind: 'github', id: 'octo/sales', name: 'octo/sales', url: 'https://github.com/octo/sales' },
    { kind: 'local', id: 'C:\\Projects\\sales', name: 'C:\\Projects\\sales' }
  ],
  kept: [],
  needsDeletePermission: false
}

type Listener = (event: TeamProgressEvent) => void

/** Install `window.api.team` mocks; returns a way to stream progress events. */
function installApi(team: Record<string, unknown>): (event: TeamProgressEvent) => void {
  const listeners: Listener[] = []
  ;(window as unknown as { api: unknown }).api = {
    openExternal: vi.fn(() => Promise.resolve()),
    team: {
      abandonPlan: vi.fn(() => Promise.resolve(plan)),
      onProgress: vi.fn((cb: Listener) => {
        listeners.push(cb)
        return () => {}
      }),
      ...team
    }
  }
  return (event) => listeners.forEach((cb) => cb(event))
}

async function renderModal(props: Partial<ComponentProps<typeof AbandonSetupModal>> = {}): Promise<void> {
  await act(async () => {
    render(
      <OverlayProvider>
        <AbandonSetupModal workspace={workspace} onClose={() => {}} onGone={() => {}} onChanged={() => {}} {...props} />
      </OverlayProvider>
    )
  })
}

function button(name: string | RegExp): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement
}

describe('TeamWorkspaceCard', () => {
  it('offers to finish or abandon an unfinished setup', () => {
    const onFinishSetup = vi.fn()
    const onAbandonSetup = vi.fn()
    render(
      <TeamWorkspaceCard
        workspace={workspace}
        opening={null}
        onOpenApp={() => {}}
        onNewApp={() => {}}
        onFinishSetup={onFinishSetup}
        onAbandonSetup={onAbandonSetup}
      />
    )
    fireEvent.click(button('Abandon setup…'))
    expect(onAbandonSetup).toHaveBeenCalledWith(workspace)
    fireEvent.click(button('Finish setup'))
    expect(onFinishSetup).toHaveBeenCalledWith(workspace)
  })
})

describe('AbandonSetupModal', () => {
  it('builds its checklist from what will be deleted', () => {
    expect(abandonSteps(plan.items).map((s) => s.label)).toEqual([
      'Look up what setup created',
      'Delete the deploy identity',
      'Delete the Fabric workspaces',
      'Delete the GitHub repository',
      'Remove the workspace from this computer'
    ])
    expect(abandonSteps([]).map((s) => s.id)).toEqual(['check', 'local'])
  })

  it('lists what setup created, then deletes it and forgets the workspace', async () => {
    const abandonSetup = vi.fn<(workspaceId: string, scope: string) => Promise<TeamActionResult>>(() =>
      Promise.resolve({ ok: true })
    )
    installApi({ abandonSetup })
    const onGone = vi.fn()
    await renderModal({ onGone })

    expect(screen.getByRole('heading').textContent).toBe('Abandon setting up Sales?')
    expect(screen.getByText('Fabricator deploy - Sales')).toBeTruthy()
    expect(screen.getAllByText('Fabric workspace')).toHaveLength(2)
    fireEvent.click(button('octo/sales'))
    expect(window.api.openExternal).toHaveBeenCalledWith('https://github.com/octo/sales')

    await act(async () => fireEvent.click(button('Delete and abandon')))
    expect(abandonSetup).toHaveBeenCalledWith('w1', expect.stringMatching(/^team-abandon-/))
    expect(onGone).toHaveBeenCalled()
  })

  it('asks GitHub for permission to delete the repository first', async () => {
    vi.useFakeTimers()
    const githubSignIn = vi.fn(() => Promise.resolve({ ok: true }))
    const envStatus = vi.fn(() =>
      Promise.resolve({ ghInstalled: true, ghSignedIn: true, ghMissingScopes: [], ghCanDeleteRepos: true, azSignedIn: true })
    )
    installApi({
      abandonPlan: vi.fn(() => Promise.resolve({ ...plan, needsDeletePermission: true })),
      githubSignIn,
      envStatus
    })
    await renderModal()

    expect(button('Delete and abandon').disabled).toBe(true)
    await act(async () => fireEvent.click(button('Grant GitHub access')))
    expect(githubSignIn).toHaveBeenCalledWith(true, true, 'octo')
    expect(envStatus).not.toHaveBeenCalled()
    expect(button('Waiting…')).toBeTruthy()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(envStatus).toHaveBeenCalledWith('octo')
    expect(screen.queryByRole('button', { name: /Grant GitHub access|Waiting…/ })).toBeNull()
    expect(button('Delete and abandon').disabled).toBe(false)
  })

  it('shows what stopped the cleanup and what removing the workspace here would keep', async () => {
    let emit: (event: TeamProgressEvent) => void = () => {}
    // The deploy identity and the production workspace went; the previews workspace didn't.
    const leftOver: TeamWorkspace = {
      ...workspace,
      setup: { ...workspace.setup!, appId: undefined, productionWorkspaceId: undefined }
    }
    const abandonSetup = vi.fn((_workspaceId: string, scope: string) => {
      const step = (id: string, state: TeamProgressEvent['state']): void => emit({ scope, step: id, state, label: id })
      step('check', 'done')
      step('identity', 'done')
      step('fabric', 'error')
      return Promise.resolve({
        ok: false,
        error: 'stopped',
        problem: { step: 'fabric', message: 'Delete the Fabric workspace "Sales previews": InsufficientPrivileges.' },
        workspace: leftOver
      })
    })
    const leave = vi.fn(() => Promise.resolve({}))
    emit = installApi({ abandonSetup, leave })
    const onChanged = vi.fn()
    const onGone = vi.fn()
    await renderModal({ onChanged, onGone })

    await act(async () => fireEvent.click(button('Delete and abandon')))
    expect(onChanged).toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('InsufficientPrivileges')
    expect(screen.getByText('Delete the deploy identity').closest('li')?.className).toContain('team-step--done')
    expect(screen.getByText("Remove from this computer keeps what's left: Sales previews, octo/sales.")).toBeTruthy()
    expect(button('Try again')).toBeTruthy()

    await act(async () => fireEvent.click(button('Remove from this computer')))
    expect(leave).toHaveBeenCalledWith('w1')
    expect(onGone).toHaveBeenCalled()
  })

  it('explains a lookup problem before anything is deleted', async () => {
    const abandonPlan = vi.fn(() =>
      Promise.resolve({
        ok: false,
        error: 'expired',
        problem: { step: 'check', message: 'Check your Azure sign-in: your Azure sign-in has expired.' },
        items: [],
        kept: [],
        needsDeletePermission: false
      })
    )
    installApi({ abandonPlan })
    await renderModal()

    expect(screen.getByRole('alert').textContent).toContain('Azure sign-in has expired')
    expect(screen.getByText('Remove from this computer keeps everything setup created.')).toBeTruthy()
    await act(async () => fireEvent.click(button('Try again')))
    expect(abandonPlan).toHaveBeenCalledTimes(2)
  })
})

describe('CreateTeamWorkspaceModal', () => {
  it('offers to abandon a setup that failed', async () => {
    const failed = { ...workspace, setup: { ...workspace.setup!, problem: { step: 'identity', message: 'Blocked.' } } }
    ;(window as unknown as { api: unknown }).api = {
      team: {
        envStatus: vi.fn(() =>
          Promise.resolve({
            ghInstalled: true,
            ghSignedIn: true,
            ghUser: 'octo',
            ghMissingScopes: [],
            ghAccounts: [{ login: 'octo', active: true, signedIn: true, missingScopes: [], canDeleteRepos: false }],
            azSignedIn: true
          })
        ),
        resumeSetup: vi.fn(() =>
          Promise.resolve({ ok: false, error: 'Blocked.', problem: { step: 'identity', message: 'Blocked.' }, workspace: failed })
        ),
        onProgress: vi.fn(() => () => {}),
        onDiagnosis: vi.fn(() => () => {}),
        diagnose: vi.fn(() => new Promise(() => {})),
        cancel: vi.fn(() => Promise.resolve(true))
      }
    }
    const onAbandon = vi.fn()
    await act(async () => {
      render(
        <OverlayProvider>
          <CreateTeamWorkspaceModal resume={workspace} onClose={() => {}} onChanged={() => {}} onAbandon={onAbandon} />
        </OverlayProvider>
      )
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Abandon setup…' }))
    expect(onAbandon).toHaveBeenCalledWith(failed)
  })
})
