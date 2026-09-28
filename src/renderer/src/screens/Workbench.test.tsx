import type { ComponentProps, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type {
  AppSettings,
  AuthStatus,
  ChatTurnResult,
  DeployResult,
  PortConflict,
  ProcLogEvent,
  ProcResult,
  StudioProject
} from '@shared/ipc'
import { ToastProvider } from '../toast'
import { OverlayProvider } from '../overlay'
import { deferred } from '../../test/deferred'
import type { DeployUiState } from '../components/PreviewPane'
import type ChatPanel from '../components/ChatPanel'
import Workbench from './Workbench'

const chatProps = vi.hoisted(() => vi.fn<(props: ComponentProps<typeof ChatPanel>) => void>())
/** Whether the mocked dependency guard reports the project's tools as unlocked. */
const guardState = vi.hoisted(() => ({ ready: true }))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setTitle: vi.fn().mockResolvedValue(undefined) })
}))
vi.mock('../chatEventStore', () => ({ useChatEventStore: () => {} }))
vi.mock('../components/HomeView', () => ({ default: () => <div data-testid="home">Home</div> }))
vi.mock('../components/ModelTab', () => ({ default: () => null }))
vi.mock('../components/advisor/AdvisorView', () => ({ default: () => null }))
vi.mock('../advisor/store', () => ({
  useAdvisor: () => ({ derived: { badge: null }, handOff: vi.fn() })
}))
vi.mock('../components/GitControl', () => ({ default: () => null }))
vi.mock('../components/WorkspaceStatus', () => ({ default: () => null }))
vi.mock('../components/RayfinVersionControl', () => ({ default: () => null }))
vi.mock('../components/ProjectDependencyGuard', async () => {
  const { useLayoutEffect } = await import('react')
  return {
    default: function GuardMock({
      children,
      project,
      onReadyChange
    }: {
      children: ReactNode
      project: StudioProject
      onReadyChange?: (projectId: string, ready: boolean) => void
    }) {
      const ready = guardState.ready
      useLayoutEffect(() => onReadyChange?.(project.id, ready), [onReadyChange, project.id, ready])
      return ready ? <>{children}</> : <div role="status">Preparing {project.name}</div>
    }
  }
})
vi.mock('../components/DeploymentsControl', () => ({
  default: ({
    running,
    onRedeploy,
    onSwitch
  }: {
    running: boolean
    onRedeploy: () => void
    onSwitch: (workspace: string, byId: boolean) => Promise<DeployResult>
  }) => (
    <>
      <button disabled={running} onClick={onRedeploy}>Test deploy</button>
      <button onClick={() => void onSwitch('ws-other', true)}>Test switch</button>
    </>
  )
}))
vi.mock('../components/PreviewPane', () => ({
  default: ({ deploy }: { deploy?: DeployUiState }) => (
    <>
      <div data-testid="deploy-state">
        {deploy?.running ? 'running' : (deploy?.result?.error ?? 'idle')}
      </div>
      <output data-testid="deploy-log">{deploy?.log.join('')}</output>
    </>
  )
}))
vi.mock('../components/ChatPanel', () => ({
  default: (props: ComponentProps<typeof ChatPanel>) => {
    chatProps(props)
    return (
      <textarea
        aria-label="Chat draft"
        value={props.draft}
        onChange={(event) => props.onDraftChange?.(event.target.value)}
      />
    )
  }
}))

const auth: AuthStatus = {
  copilot: { signedIn: true, user: 'octocat' },
  rayfin: { signedIn: true, user: 'dev@example.com' },
  az: { signedIn: true }
}
const project: StudioProject = {
  id: 'p1',
  name: 'Project One',
  path: 'C:\\projects\\p1',
  addedAt: '2026-09-12T00:00:00Z',
  lastDeploy: { url: 'https://project.example.com', status: 'success' }
}

function installApi(active = false) {
  const state = {
    workspaceRoot: 'C:\\projects',
    activeProjectId: active ? project.id : null,
    projects: active ? [project] : []
  }
  const api = {
    auth: {
      loginRayfin: vi.fn().mockResolvedValue({ ok: true, exitCode: 0 }),
      refreshRayfin: vi.fn().mockResolvedValue({ ok: true, exitCode: 0 }),
      logoutRayfin: vi.fn().mockResolvedValue({ ok: true, exitCode: 0 })
    },
    projects: {
      state: vi.fn().mockResolvedValue(state),
      git: { divergence: vi.fn().mockResolvedValue({ behind: 0 }) }
    },
    deploy: {
      reconcile: vi.fn().mockResolvedValue(state),
      hasChanges: vi.fn().mockResolvedValue(false),
      run: vi.fn().mockResolvedValue({ ok: true, outcome: 'success' }),
      switch: vi.fn().mockResolvedValue({ ok: true, outcome: 'success' })
    },
    chat: {
      history: vi.fn().mockResolvedValue([]),
      saveHistory: vi.fn().mockResolvedValue(undefined)
    },
    rayfin: { versions: vi.fn().mockResolvedValue(null) },
    preview: { onAgentPreview: vi.fn(() => () => {}) },
    getVersions: vi.fn().mockResolvedValue(null),
    onProcLog: vi.fn<(callback: (event: ProcLogEvent) => void) => () => void>(() => () => {})
  }
  ;(window as unknown as { api: unknown }).api = api
  return api
}

function makeProps(overrides: Partial<ComponentProps<typeof Workbench>> = {}) {
  return {
    auth,
    onSignOut: vi.fn().mockResolvedValue(undefined),
    onAuthChanged: vi.fn().mockResolvedValue(undefined),
    settings: null,
    onSettingsChange: vi.fn(),
    ...overrides
  }
}

function Wrapper({ children }: { children: ReactNode }): JSX.Element {
  return (
    <ToastProvider>
      <OverlayProvider>{children}</OverlayProvider>
    </ToastProvider>
  )
}

function completeTurn(
  result: ChatTurnResult = { ok: true, filesModified: [], ranDeploy: false }
): void {
  const callback = chatProps.mock.lastCall?.[0].onTurnComplete
  if (!callback) throw new Error('Chat completion handler is not mounted')
  callback(result)
}

/** Opens the app bar's account menu (unless it already is) and returns an item. */
function accountAction(name: string): HTMLButtonElement {
  if (!screen.queryByRole('menu', { name: 'Fabric account' })) {
    fireEvent.click(screen.getByRole('button', { name: /^Account/ }))
  }
  return screen.getByRole('menuitem', { name }) as HTMLButtonElement
}

beforeEach(() => {
  chatProps.mockClear()
  guardState.ready = true
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  delete (window as unknown as { api?: unknown }).api
})

describe('Workbench authentication recovery', () => {
  it('requires confirmation before clearing shared Fabric credentials', async () => {
    const api = installApi(true)
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')
    fireEvent.click(accountAction('Refresh Fabric authentication'))
    expect(screen.getByRole('dialog').textContent).toContain('shared across projects')
    expect(api.auth.refreshRayfin).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.auth.refreshRayfin).not.toHaveBeenCalled()
  })

  it('refreshes the selected session without leaving the workbench or replaying deployment', async () => {
    const api = installApi(true)
    const refreshed = deferred<ProcResult>()
    api.auth.refreshRayfin.mockReturnValueOnce(refreshed.promise)
    const props = makeProps({ auth: { ...auth, rayfin: { ...auth.rayfin, tenant: 'tenant-one' } } })
    const view = render(<Workbench {...props} />, { wrapper: Wrapper })
    const draft = (await screen.findByLabelText('Chat draft')) as HTMLTextAreaElement
    fireEvent.change(draft, { target: { value: 'Keep this draft' } })
    fireEvent.click(accountAction('Refresh Fabric authentication'))
    view.rerender(<Workbench {...props} auth={{ ...auth, rayfin: { ...auth.rayfin, tenant: 'tenant-two' } }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Clear credentials and sign in' }))
    expect(api.auth.refreshRayfin).toHaveBeenCalledWith(project.id, 'tenant-one')
    expect(accountAction('Sign out').disabled).toBe(true)

    const log = 'Removed a stale token-cache lock left by an interrupted sign-in\n'
    act(() => api.onProcLog.mock.calls[0][0]({ channel: 'refresh:rayfin', stream: 'stderr', data: log }))
    expect(screen.getByLabelText('Authentication refresh log').textContent).toBe(log)
    fireEvent.click(screen.getByRole('button', { name: 'Test deploy' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Deployment paused'))
    expect(api.deploy.run).not.toHaveBeenCalled()
    await act(async () => refreshed.resolve({ ok: true, exitCode: 0 }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByLabelText('Chat draft')).toBe(draft)
    expect(draft.value).toBe('Keep this draft')
    expect(screen.getByTestId('deploy-log').textContent).toContain(log)
    expect(props.onSignOut).not.toHaveBeenCalled()
    expect(api.auth.logoutRayfin).not.toHaveBeenCalled()
    expect(api.deploy.run).not.toHaveBeenCalled()
  })

  it.each(['failed result', 'rejected IPC', 'verification'])(
    'keeps refresh failures visible and allows retry after %s',
    async (failure) => {
      const api = installApi(true)
      const props = makeProps()
      render(<Workbench {...props} />, { wrapper: Wrapper })
      await screen.findByLabelText('Chat draft')
      await act(async () => {})
      if (failure === 'failed result') {
        api.auth.refreshRayfin.mockResolvedValueOnce({ ok: false, exitCode: 1, error: 'Credential refresh failed' })
      } else if (failure === 'rejected IPC') {
        api.auth.refreshRayfin.mockRejectedValueOnce('Credential refresh failed')
      } else {
        vi.mocked(props.onAuthChanged).mockRejectedValueOnce('Credential refresh failed')
      }
      fireEvent.click(accountAction('Refresh Fabric authentication'))
      fireEvent.click(screen.getByRole('button', { name: 'Clear credentials and sign in' }))

      expect((await screen.findByRole('alert')).textContent).toContain('Credential refresh failed')
      await waitFor(() =>
        expect((screen.getByRole('button', { name: 'Clear credentials and sign in' }) as HTMLButtonElement).disabled).toBe(false)
      )
      expect(api.deploy.run).not.toHaveBeenCalled()
      expect(props.onSignOut).not.toHaveBeenCalled()
    }
  )

  it('does not replay queued deployments or automatically clear a token-cache failure', async () => {
    const api = installApi(true)
    const deploying = deferred<DeployResult>()
    api.deploy.hasChanges.mockResolvedValue(true)
    api.deploy.run.mockReturnValueOnce(deploying.promise)
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')
    await act(async () => completeTurn())
    await act(async () => completeTurn())
    await act(async () => deploying.resolve({
      ok: false,
      outcome: 'auth-cache-error',
      error: 'Could not acquire the token-cache lock'
    }))
    expect(api.deploy.run).toHaveBeenCalledTimes(1)
    expect(api.auth.loginRayfin).not.toHaveBeenCalled()
    expect(api.auth.refreshRayfin).not.toHaveBeenCalled()
    expect(api.auth.logoutRayfin).not.toHaveBeenCalled()
  })

  it('still retries a normal expired session once using the deploying project CLI', async () => {
    const api = installApi(true)
    api.deploy.run.mockResolvedValueOnce({ ok: false, outcome: 'not-signed-in' })
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    fireEvent.click(await screen.findByRole('button', { name: 'Test deploy' }))
    await waitFor(() => expect(api.deploy.run).toHaveBeenCalledTimes(2))
    expect(api.auth.loginRayfin).toHaveBeenCalledTimes(1)
    expect(api.auth.loginRayfin).toHaveBeenCalledWith(undefined, project.id)
    expect(api.auth.refreshRayfin).not.toHaveBeenCalled()
    expect(api.auth.logoutRayfin).not.toHaveBeenCalled()
  })

  it('clears a previous deploy failure after switching to another deployment', async () => {
    const api = installApi(true)
    api.deploy.run.mockResolvedValueOnce({ ok: false, outcome: 'error', error: 'Upload failed' })
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    fireEvent.click(await screen.findByRole('button', { name: 'Test deploy' }))
    await waitFor(() => expect(screen.getByTestId('deploy-state').textContent).toBe('Upload failed'))
    fireEvent.click(screen.getByRole('button', { name: 'Test switch' }))
    await waitFor(() => expect(screen.getByTestId('deploy-state').textContent).toBe('idle'))
  })

  it('does not recheck or redeploy after leaving during a credential refresh', async () => {
    const api = installApi(true)
    const refreshed = deferred<ProcResult>()
    api.auth.refreshRayfin.mockReturnValueOnce(refreshed.promise)
    const props = makeProps()
    const view = render(<Workbench {...props} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')
    fireEvent.click(accountAction('Refresh Fabric authentication'))
    fireEvent.click(screen.getByRole('button', { name: 'Clear credentials and sign in' }))
    vi.mocked(props.onAuthChanged).mockClear()
    view.unmount()
    await act(async () => refreshed.resolve({ ok: true, exitCode: 0 }))
    expect(props.onAuthChanged).not.toHaveBeenCalled()
    expect(api.deploy.run).not.toHaveBeenCalled()
  })

  it.each(['failed result', 'rejected IPC'])(
    'keeps the workbench open after logout %s',
    async (failure) => {
      const api = installApi()
      if (failure === 'failed result') {
        api.auth.logoutRayfin.mockResolvedValueOnce({
          ok: false,
          exitCode: 1,
          error: 'Logout failed'
        })
      } else {
        api.auth.logoutRayfin.mockRejectedValueOnce('Logout failed')
      }
      const props = makeProps()
      render(<Workbench {...props} />, { wrapper: Wrapper })
      fireEvent.click(accountAction('Sign out'))

      expect((await screen.findByRole('alert')).textContent).toContain('Logout failed')
      await waitFor(() => expect(accountAction('Sign out').disabled).toBe(false))
      expect(props.onSignOut).not.toHaveBeenCalled()
      expect(props.onAuthChanged).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('home')).toBeTruthy()
    }
  )

  it('keeps the sign-out overlay until the verified screen refresh completes', async () => {
    installApi()
    const refreshed = deferred<void>()
    const props = makeProps({ onSignOut: vi.fn(() => refreshed.promise) })
    render(<Workbench {...props} />, { wrapper: Wrapper })
    fireEvent.click(accountAction('Sign out'))

    await waitFor(() => expect(props.onSignOut).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('alertdialog', { name: 'Signing out' })).toBeTruthy()
    expect(accountAction('Signing out…').disabled).toBe(true)
    await act(async () => refreshed.resolve(undefined))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(accountAction('Sign out').disabled).toBe(false)
  })

  it.each(['login', 'verification'])(
    'reports rejected Fabric %s without leaving buttons busy',
    async (failure) => {
      const api = installApi()
      const onAuthChanged = vi.fn().mockResolvedValue(undefined)
      if (failure === 'login')
        api.auth.loginRayfin.mockRejectedValueOnce('Sign-in service unavailable')
      else onAuthChanged.mockRejectedValueOnce('Sign-in service unavailable')
      const props = makeProps({ auth: { ...auth, rayfin: { signedIn: false } }, onAuthChanged })
      render(<Workbench {...props} />, { wrapper: Wrapper })
      fireEvent.click(screen.getByRole('button', { name: 'Sign in to Fabric' }))

      expect((await screen.findByRole('alert')).textContent).toContain(
        'Sign-in service unavailable'
      )
      expect(
        (screen.getByRole('button', { name: 'Sign in to Fabric' }) as HTMLButtonElement).disabled
      ).toBe(false)
      expect(props.onSignOut).not.toHaveBeenCalled()
    }
  )

  it('does not allow sign-out to race a pending sign-in when auth props change', async () => {
    const api = installApi()
    const login = deferred<ProcResult>()
    api.auth.loginRayfin.mockReturnValueOnce(login.promise)
    const props = makeProps({ auth: { ...auth, rayfin: { signedIn: false } } })
    const view = render(<Workbench {...props} />, { wrapper: Wrapper })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Fabric' }))
    view.rerender(<Workbench {...props} auth={auth} />)
    const signOut = accountAction('Sign out')
    expect(signOut.disabled).toBe(true)
    fireEvent.click(signOut)
    expect(api.auth.logoutRayfin).not.toHaveBeenCalled()
    await act(async () => login.resolve({ ok: true, exitCode: 0 }))
  })

  it('passes live Copilot auth to chat without losing its draft on a failed check', async () => {
    installApi(true)
    const props = makeProps()
    const view = render(<Workbench {...props} />, { wrapper: Wrapper })
    const input = (await screen.findByLabelText('Chat draft')) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'Do not lose this draft' } })
    const failed = { ...auth, copilot: { signedIn: false, error: 'Session expired' } }
    view.rerender(<Workbench {...props} auth={failed} />)

    expect(screen.getByLabelText('Chat draft')).toBe(input)
    expect(input.value).toBe('Do not lose this draft')
    const passed = chatProps.mock.lastCall?.[0]
    expect(passed?.copilotAuth).toBe(failed.copilot)
    expect(passed?.onCopilotAuthChanged).toBe(props.onAuthChanged)
  })

  it.each(['failed login', 'rejected login', 'rejected verification'])(
    'does not retry a deployment after %s and settles its running state',
    async (failure) => {
      const api = installApi(true)
      const props = makeProps()
      render(<Workbench {...props} />, { wrapper: Wrapper })
      await screen.findByLabelText('Chat draft')
      await act(async () => {})
      api.deploy.run.mockResolvedValueOnce({ ok: false, outcome: 'not-signed-in' })
      if (failure === 'failed login') {
        api.auth.loginRayfin.mockResolvedValueOnce({
          ok: false,
          exitCode: 1,
          error: 'Authentication denied'
        })
      } else if (failure === 'rejected login') {
        api.auth.loginRayfin.mockRejectedValueOnce('Authentication denied')
      } else {
        vi.mocked(props.onAuthChanged).mockRejectedValueOnce(new Error('Authentication denied'))
      }

      fireEvent.click(screen.getByRole('button', { name: 'Test deploy' }))

      await waitFor(() =>
        expect(screen.getByTestId('deploy-state').textContent).toBe('Authentication denied')
      )
      expect(api.deploy.run).toHaveBeenCalledTimes(1)
      expect(api.auth.loginRayfin).toHaveBeenCalledTimes(1)
      expect(props.onSignOut).not.toHaveBeenCalled()
      expect(
        (screen.getByRole('button', { name: 'Test deploy' }) as HTMLButtonElement).disabled
      ).toBe(false)
    }
  )

  it('does not retry deployment after leaving the workbench during sign-in', async () => {
    const api = installApi(true)
    const login = deferred<ProcResult>()
    const props = makeProps()
    const view = render(<Workbench {...props} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')
    api.deploy.run.mockResolvedValueOnce({ ok: false, outcome: 'not-signed-in' })
    api.auth.loginRayfin.mockReturnValueOnce(login.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Test deploy' }))
    await waitFor(() => expect(api.auth.loginRayfin).toHaveBeenCalledTimes(1))
    vi.mocked(props.onAuthChanged).mockClear()
    view.unmount()
    await act(async () => login.resolve({ ok: true, exitCode: 0 }))

    expect(api.deploy.run).toHaveBeenCalledTimes(1)
    expect(props.onAuthChanged).not.toHaveBeenCalled()
  })

  it('refreshes auth instead of treating an unauthenticated deployment switch as successful', async () => {
    const api = installApi(true)
    api.deploy.switch.mockResolvedValueOnce({ ok: false, outcome: 'not-signed-in' })
    const props = makeProps()
    render(<Workbench {...props} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')
    await act(async () => {})
    vi.mocked(props.onAuthChanged).mockClear()
    api.projects.state.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Test switch' }))

    await waitFor(() => expect(props.onAuthChanged).toHaveBeenCalledTimes(1))
    expect(api.projects.state).not.toHaveBeenCalled()
    expect(props.onSignOut).not.toHaveBeenCalled()
  })
})

describe('Workbench app bar', () => {
  it('puts the project, its views, deploys and the account on one bar without the brand', async () => {
    installApi(true)
    const { container } = render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')

    const bar = container.querySelector('header.app-bar') as HTMLElement
    expect(container.querySelectorAll('header')).toHaveLength(1)
    expect(bar.textContent).not.toContain('Fabricator')
    const inBar = within(bar)
    expect(inBar.getByRole('button', { name: 'Project One — Switch projects' })).toBeTruthy()
    expect(inBar.getByRole('tablist', { name: 'Project views' })).toBeTruthy()
    expect(inBar.getByRole('button', { name: 'Test deploy' })).toBeTruthy()
    expect(inBar.getByRole('button', { name: 'Settings' })).toBeTruthy()
    expect(inBar.getByRole('button', { name: 'Account: dev@example.com' })).toBeTruthy()
  })

  it('opens the launcher from the project name and returns to the still-open project', async () => {
    installApi(true)
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    const draft = await screen.findByLabelText('Chat draft')

    fireEvent.click(screen.getByRole('button', { name: 'Project One — Switch projects' }))
    expect(screen.getByTestId('home')).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Test deploy' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Back to Project One' }))
    expect(screen.queryByTestId('home')).toBeNull()
    expect(screen.getByRole('tablist', { name: 'Project views' })).toBeTruthy()
    expect(screen.getByLabelText('Chat draft')).toBe(draft)
  })

  it('keeps tabs and deploys locked until the project dependencies are ready', async () => {
    guardState.ready = false
    installApi(true)
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })

    expect(await screen.findByText('Preparing Project One')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Project One — Switch projects' })).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Test deploy' })).toBeNull()
  })

  it('keeps credential refresh reachable while signed out of Fabric', async () => {
    const api = installApi(true)
    render(<Workbench {...makeProps({ auth: { ...auth, rayfin: { signedIn: false } } })} />, {
      wrapper: Wrapper
    })
    await screen.findByLabelText('Chat draft')

    expect(screen.queryByRole('button', { name: /^Account/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Sign in to Fabric' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'More sign-in options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Refresh Fabric authentication' }))
    expect(screen.getByRole('dialog').textContent).toContain('shared across projects')
    expect(api.auth.refreshRayfin).not.toHaveBeenCalled()
  })
})

describe('Workbench after-turn deployment', () => {
  it('redeploys undeployed changes even without file-edit events from the agent', async () => {
    const api = installApi(true)
    api.deploy.hasChanges.mockResolvedValue(true)
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')

    await act(async () => completeTurn())

    expect(api.deploy.hasChanges).toHaveBeenCalledWith(project.id)
    expect(api.deploy.run).toHaveBeenCalledTimes(1)
    expect(api.deploy.run).toHaveBeenCalledWith(project.id, undefined)
    expect(api.projects.git.divergence).not.toHaveBeenCalled()
  })

  it('does not redeploy when the deployed content is unchanged', async () => {
    const api = installApi(true)
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')

    await act(async () => completeTurn())

    expect(api.deploy.hasChanges).toHaveBeenCalledWith(project.id)
    expect(api.deploy.run).not.toHaveBeenCalled()
  })

  it.each([undefined, 'Coding failed'])(
    'does not auto-deploy an unsuccessful turn (%s)',
    async (error) => {
      const api = installApi(true)
      api.deploy.hasChanges.mockResolvedValue(true)
      render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
      await screen.findByLabelText('Chat draft')

      await act(async () =>
        completeTurn({ ok: false, error, filesModified: ['app.ts'], ranDeploy: false })
      )

      expect(api.deploy.hasChanges).not.toHaveBeenCalled()
      expect(api.deploy.run).not.toHaveBeenCalled()
    }
  )

  it.each(['project refresh', 'history save', 'version check'])(
    'still redeploys and reports a failed %s',
    async (failure) => {
      const api = installApi(true)
      api.deploy.hasChanges.mockResolvedValue(true)
      render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
      await screen.findByLabelText('Chat draft')
      await act(async () => {})
      const operation =
        failure === 'project refresh'
          ? api.projects.state
          : failure === 'history save'
            ? api.chat.saveHistory
            : api.rayfin.versions
      operation.mockRejectedValueOnce(new Error(`${failure} unavailable`))

      await act(async () => completeTurn())

      expect(api.deploy.run).toHaveBeenCalledTimes(1)
      expect(api.deploy.run).toHaveBeenCalledWith(project.id, undefined)
      expect(screen.getByRole('alert').textContent).toContain(`${failure} unavailable`)
    }
  )

  it.each(['Git unavailable', new Error('Git unavailable')])(
    'surfaces a failed change check (%s) instead of silently skipping deployment',
    async (error) => {
      const api = installApi(true)
      api.deploy.hasChanges.mockRejectedValueOnce(error)
      render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
      await screen.findByLabelText('Chat draft')

      await act(async () => completeTurn())

      expect(screen.getByRole('alert').textContent).toContain('Auto-deploy check failed')
      expect(screen.getByRole('alert').textContent).toContain('Git unavailable')
      expect(screen.getByRole('alert').textContent).toContain('Use Redeploy')
      expect(api.deploy.run).not.toHaveBeenCalled()
    }
  )

  it('queues a new deployment when another turn finishes during deployment', async () => {
    const api = installApi(true)
    const deploying = deferred<DeployResult>()
    api.deploy.hasChanges.mockResolvedValue(true)
    api.deploy.run.mockReturnValueOnce(deploying.promise)
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')

    await act(async () => completeTurn())
    await act(async () => completeTurn())
    expect(api.deploy.run).toHaveBeenCalledTimes(1)

    await act(async () => deploying.resolve({ ok: true, outcome: 'success' }))

    expect(api.deploy.run).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('deploy-state').textContent).toBe('idle')
  })

  it('does not start an auto-deploy after the workbench is unmounted', async () => {
    const api = installApi(true)
    const changed = deferred<boolean>()
    api.deploy.hasChanges.mockReturnValueOnce(changed.promise)
    const view = render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')

    await act(async () => completeTurn())
    expect(api.deploy.hasChanges).toHaveBeenCalledWith(project.id)
    view.unmount()
    await act(async () => changed.resolve(true))

    expect(api.deploy.run).not.toHaveBeenCalled()
  })
})

/**
 * Live local preview ports: a turn starts Vite on a port the app's sign-in
 * accepts. When every such port is taken, the turn waits while the user
 * registers another port (rayfin.yml + a settings push) or stops the process.
 */
describe('Workbench live preview ports', () => {
  const settings: AppSettings = { theme: 'system', experiments: { localDevPreview: true } }
  const conflict: PortConflict = {
    port: 5173,
    occupant: { pid: 4321, name: 'node.exe', commandLine: 'node C:\\other-app\\node_modules\\vite\\bin\\vite.js' },
    canStop: true,
    suggestedPort: 5174,
    needsPush: true
  }

  function installDev(api: ReturnType<typeof installApi>) {
    const dev = {
      plan: vi.fn().mockResolvedValue({ conflict }),
      start: vi.fn().mockResolvedValue({ ok: true, outcome: 'running', url: 'http://localhost:5174' }),
      stop: vi.fn().mockResolvedValue(undefined),
      freePort: vi.fn().mockResolvedValue(undefined),
      registerPort: vi.fn().mockResolvedValue({ ok: true, outcome: 'success' })
    }
    Object.assign(api, { dev })
    return dev
  }

  async function mount() {
    const api = installApi(true)
    const dev = installDev(api)
    render(<Workbench {...makeProps({ settings })} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')
    return { api, dev }
  }

  /** Start a fresh turn the way ChatPanel does. `turn` settles once it may be sent. */
  async function beginTurn(): Promise<{ turn: Promise<void> }> {
    const start = chatProps.mock.lastCall?.[0].onTurnStart
    if (!start) throw new Error('Chat turn-start handler is not mounted')
    let turn!: Promise<void>
    await act(async () => {
      turn = Promise.resolve(start())
    })
    return { turn }
  }

  it('starts straight away on a free port that sign-in accepts', async () => {
    const { dev } = await mount()
    dev.plan.mockResolvedValue({ port: 5174 })
    const { turn } = await beginTurn()
    await act(async () => turn)
    expect(dev.start).toHaveBeenCalledWith(project.id, 5174)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('holds the turn until another port is registered and pushed, then starts on it', async () => {
    const { api, dev } = await mount()
    const pushed = deferred<DeployResult>()
    dev.registerPort.mockReturnValueOnce(pushed.promise)
    let sent = false
    const { turn } = await beginTurn()
    void turn.then(() => {
      sent = true
    })
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('localhost:5173 is in use')
    expect(dialog.textContent).toContain('node.exe')
    expect(dialog.textContent).toContain('PID 4321')
    expect(dialog.textContent).toContain('vite.js')

    fireEvent.click(screen.getByRole('button', { name: 'Use port 5174' }))
    expect(dev.registerPort).toHaveBeenCalledWith(project.id, 5174)
    act(() => api.onProcLog.mock.calls[0][0]({ channel: 'dev:register', stream: 'system', data: 'Pushing sign-in settings\n' }))
    expect(screen.getByLabelText('Port registration log').textContent).toContain('Pushing sign-in settings')
    await act(async () => {})
    expect(sent).toBe(false)
    expect(dev.start).not.toHaveBeenCalled()

    await act(async () => {
      pushed.resolve({ ok: true, outcome: 'success' })
      await turn
    })
    expect(sent).toBe(true)
    expect(dev.start).toHaveBeenCalledWith(project.id, 5174)
    expect(dev.freePort).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('stops the process holding the port when asked, then starts on that port', async () => {
    const { dev } = await mount()
    const { turn } = await beginTurn()
    fireEvent.click(screen.getByRole('button', { name: 'Stop node.exe' }))
    await act(async () => turn)
    expect(dev.freePort).toHaveBeenCalledWith(5173, 4321)
    expect(dev.registerPort).not.toHaveBeenCalled()
    expect(dev.start).toHaveBeenCalledWith(project.id, 5173)
  })

  it.each([
    ['stopping', 'Stop node.exe', 'Access is denied.'],
    ['pushing', 'Use port 5174', 'Workspace not found']
  ])('keeps the prompt open with the reason when %s fails, and skipping still sends the turn', async (_, action, reason) => {
    const { dev } = await mount()
    dev.freePort.mockRejectedValueOnce(reason)
    dev.registerPort.mockResolvedValueOnce({ ok: false, outcome: 'error', error: reason })
    const { turn } = await beginTurn()
    fireEvent.click(screen.getByRole('button', { name: action }))
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain(reason))
    expect(dev.start).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Skip live preview' }))
    await act(async () => turn)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(dev.start).not.toHaveBeenCalled()
  })

  it('signs in and retries once when the push finds an expired Fabric session', async () => {
    const { api, dev } = await mount()
    dev.registerPort.mockResolvedValueOnce({ ok: false, outcome: 'not-signed-in', error: 'Unauthorized' })
    const { turn } = await beginTurn()
    fireEvent.click(screen.getByRole('button', { name: 'Use port 5174' }))
    await act(async () => turn)
    expect(api.auth.loginRayfin).toHaveBeenCalledWith(undefined, project.id)
    expect(dev.registerPort).toHaveBeenCalledTimes(2)
    expect(dev.start).toHaveBeenCalledWith(project.id, 5174)
  })

  it('does not ask again in a turn the user skipped, but does on the next turn', async () => {
    const { dev } = await mount()
    const { turn } = await beginTurn()
    fireEvent.click(screen.getByRole('button', { name: 'Skip live preview' }))
    await act(async () => turn)
    await act(async () => chatProps.mock.lastCall?.[0].onPlanExecutionStart?.())
    expect(dev.plan).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()

    await act(async () => completeTurn())
    await beginTurn()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(dev.plan).toHaveBeenCalledTimes(2)
  })

  it('offers only stopping mid-turn, since a new port would need a push', async () => {
    const { dev } = await mount()
    act(() => {
      chatProps.mock.lastCall?.[0].onChange(() => [
        { id: 'a1', role: 'assistant', text: '', tools: [], pending: true }
      ] as never)
    })
    await act(async () => chatProps.mock.lastCall?.[0].onPlanExecutionStart?.())
    const dialog = screen.getByRole('dialog')
    expect(screen.queryByRole('button', { name: 'Use port 5174' })).toBeNull()
    expect(dialog.textContent).toContain('while Copilot is working')
    fireEvent.click(screen.getByRole('button', { name: 'Stop node.exe' }))
    await waitFor(() => expect(dev.start).toHaveBeenCalledWith(project.id, 5173))
    expect(dev.registerPort).not.toHaveBeenCalled()
  })

  it('skips with a notice when there is nothing to offer', async () => {
    const { dev } = await mount()
    dev.plan.mockResolvedValue({ conflict: { port: 5173, canStop: false, needsPush: true } })
    const { turn } = await beginTurn()
    await act(async () => turn)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(await screen.findByText('Live preview skipped')).toBeTruthy()
    expect(dev.start).not.toHaveBeenCalled()
  })

  it('never asks when the experiment is off', async () => {
    const api = installApi(true)
    const dev = installDev(api)
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')
    const { turn } = await beginTurn()
    await act(async () => turn)
    expect(dev.plan).not.toHaveBeenCalled()
    expect(dev.start).not.toHaveBeenCalled()
  })
})
