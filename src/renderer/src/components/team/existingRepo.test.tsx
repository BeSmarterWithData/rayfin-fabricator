import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TeamAbandonPlan, TeamEnvStatus, TeamOwner, TeamProblem, TeamWorkspace } from '@shared/ipc'
import { OverlayProvider } from '../../overlay'
import AbandonSetupModal, { abandonSteps, stillThere } from './AbandonSetupModal'
import CreateTeamWorkspaceModal, { parseRepo } from './CreateTeamWorkspaceModal'
import JoinTeamWorkspaceModal from './JoinTeamWorkspaceModal'

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

const env: TeamEnvStatus = {
  enabled: true,
  ghInstalled: true,
  ghSignedIn: true,
  ghUser: 'amy_contoso',
  ghMissingScopes: [],
  ghCanDeleteRepos: false,
  ghAccounts: [{ login: 'amy_contoso', active: true, signedIn: true, missingScopes: [], canDeleteRepos: false }],
  azSignedIn: true
}

/** As GitHub lists them for a member of organizations that don't let members create repositories. */
const owners: TeamOwner[] = [
  { login: 'amy_contoso', isOrg: false },
  { login: 'azure-data', isOrg: true, canCreate: false },
  { login: 'contoso-labs', isOrg: true, canCreate: true }
]

function install(team: Record<string, unknown>): void {
  ;(window as unknown as { api: unknown }).api = {
    openExternal: vi.fn(),
    team: {
      envStatus: vi.fn(() => Promise.resolve(env)),
      owners: vi.fn(() => Promise.resolve({ ok: true, owners })),
      capacities: vi.fn(() =>
        Promise.resolve({ ok: true, capacities: [{ id: 'cap1', displayName: 'F8', kind: 'fabric', eligible: true }] })
      ),
      onProgress: vi.fn(() => () => {}),
      onDiagnosis: vi.fn(() => () => {}),
      diagnose: vi.fn(() => new Promise(() => {})),
      cancel: vi.fn(() => Promise.resolve(true)),
      ...team
    }
  }
}

async function openCreate(): Promise<void> {
  await act(async () => {
    render(
      <OverlayProvider>
        <CreateTeamWorkspaceModal onClose={() => {}} onChanged={() => {}} />
      </OverlayProvider>
    )
  })
  fireEvent.change(screen.getByPlaceholderText('Sales team apps'), { target: { value: 'Sales apps' } })
}

const createButton = (): HTMLButtonElement => screen.getByRole('button', { name: 'Create workspace' }) as HTMLButtonElement

describe('existing repositories', () => {
  it('are read from a name or a GitHub address, as setup reads them', () => {
    for (const input of [
      'azure-data/sales-apps',
      ' https://github.com/azure-data/sales-apps/ ',
      'github.com/azure-data/sales-apps.git',
      'git@github.com:azure-data/sales-apps.git',
      'HTTPS://WWW.GitHub.com/azure-data/sales-apps'
    ]) {
      expect(parseRepo(input), input).toBe('azure-data/sales-apps')
    }
    for (const input of ['', 'sales-apps', 'a/b/c', '-x/y', 'x/..', 'x/a b', 'https://github.com/x']) {
      expect(parseRepo(input), input).toBeNull()
    }
  })

  it('marks organizations where you can’t create repositories and points to an existing one', async () => {
    install({ repos: vi.fn(() => Promise.resolve({ ok: true, repos: [] })) })
    await openCreate()
    const ownerSelect = screen.getByLabelText('GitHub owner') as HTMLSelectElement
    expect([...ownerSelect.options].map((o) => o.textContent)).toEqual([
      'amy_contoso (you)',
      'azure-data (organization · you can’t create repositories)',
      'contoso-labs (organization)'
    ])
    expect(createButton().disabled).toBe(false)
    fireEvent.change(ownerSelect, { target: { value: 'azure-data' } })
    expect(screen.getByRole('alert').textContent).toContain('azure-data doesn’t let you create repositories')
    expect(createButton().disabled, 'setup would fail to create it').toBe(true)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Use an existing repository' })))
    expect(screen.getByRole('radio', { name: 'Existing repository' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByLabelText('Repository')).toBeTruthy()
    expect(screen.queryByLabelText('GitHub owner'), 'an existing repository decides the owner').toBeNull()
  })

  it('always offers an existing repository, with yours as suggestions', async () => {
    const create = vi.fn(() => new Promise(() => {}))
    const repos = vi.fn(() =>
      Promise.resolve({
        ok: true,
        repos: [
          { fullName: 'azure-data/sales-apps', description: 'For the Fabricator workspace' },
          { fullName: 'amy_contoso/scratch' }
        ]
      })
    )
    install({ create, repos })
    await openCreate()
    // Even when the chosen owner lets you create repositories.
    expect(screen.getByRole('radio', { name: 'New repository' }).getAttribute('aria-checked')).toBe('true')
    await act(async () => fireEvent.click(screen.getByRole('radio', { name: 'Existing repository' })))
    expect(repos).toHaveBeenCalledWith('amy_contoso')
    const field = screen.getByLabelText('Repository') as HTMLInputElement
    const suggestions = document.getElementById(field.getAttribute('list') ?? '')
    expect([...(suggestions?.querySelectorAll('option') ?? [])].map((o) => o.value)).toEqual([
      'azure-data/sales-apps',
      'amy_contoso/scratch'
    ])
    expect(createButton().disabled, 'no repository yet').toBe(true)
    fireEvent.change(field, { target: { value: 'azure-data/' } })
    expect(screen.getByRole('alert').textContent).toContain('Enter the repository as owner/name')
    expect(createButton().disabled).toBe(true)
    fireEvent.change(field, { target: { value: 'https://github.com/azure-data/sales-apps' } })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(createButton().disabled).toBe(false)
    await act(async () => fireEvent.click(createButton()))
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'azure-data', ownerIsOrg: true, existingRepo: 'azure-data/sales-apps' }),
      expect.any(String)
    )
  })

  it('creates a new repository again after switching back', async () => {
    const create = vi.fn(() => new Promise(() => {}))
    install({ create, repos: vi.fn(() => Promise.resolve({ ok: false, error: 'GitHub is unreachable.', repos: [] })) })
    await openCreate()
    await act(async () => fireEvent.click(screen.getByRole('radio', { name: 'Existing repository' })))
    // Suggestions are optional: typing still works when they can't load.
    expect(screen.getByRole('alert').textContent).toContain('GitHub is unreachable.')
    fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'azure-data/sales-apps' } })
    fireEvent.click(screen.getByRole('radio', { name: 'New repository' }))
    fireEvent.change(screen.getByLabelText('GitHub owner'), { target: { value: 'contoso-labs' } })
    await act(async () => fireEvent.click(createButton()))
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'contoso-labs', existingRepo: undefined }),
      expect.any(String)
    )
  })
})

describe('abandoning a setup that used what you provided', () => {
  const workspace: TeamWorkspace = {
    id: 'w1',
    name: 'Sales',
    repo: 'azure-data/sales-apps',
    defaultBranch: 'main',
    dir: 'C:\\Projects\\sales',
    role: 'owner',
    addedAt: '',
    account: 'amy_contoso',
    setup: {
      request: { name: 'Sales', owner: 'azure-data', capacityId: 'cap', existingClientId: 'c1', existingRepo: 'azure-data/sales-apps' },
      completed: ['github', 'fabric', 'identity', 'trust', 'access', 'files'],
      appId: 'c1',
      productionWorkspaceId: 'p',
      done: false
    }
  }
  const plan: TeamAbandonPlan = {
    ok: true,
    items: [
      { kind: 'trust', id: 'c1', name: 'Sales deploy' },
      { kind: 'fabric', id: 'p', name: 'Sales' },
      { kind: 'pipeline', id: 'azure-data/sales-apps', name: 'azure-data/sales-apps', url: 'https://github.com/azure-data/sales-apps' },
      { kind: 'local', id: 'C:\\Projects\\sales', name: 'C:\\Projects\\sales' }
    ],
    kept: [
      'The app registration you provided, "Sales deploy", stays. Fabricator only removes the federated credentials that let azure-data/sales-apps sign in as it.',
      'azure-data/sales-apps stays because you provided it.'
    ],
    needsDeletePermission: false
  }

  it('keeps them, and only removes what setup added', async () => {
    ;(window as unknown as { api: unknown }).api = {
      openExternal: vi.fn(),
      team: { abandonPlan: vi.fn(() => Promise.resolve(plan)), onProgress: vi.fn(() => () => {}) }
    }
    await act(async () => {
      render(
        <OverlayProvider>
          <AbandonSetupModal workspace={workspace} onClose={() => {}} onGone={() => {}} onChanged={() => {}} />
        </OverlayProvider>
      )
    })
    expect(screen.getByText(/removes what it added to what you provided/)).toBeTruthy()
    expect(screen.getByText('Its federated credentials for this workspace')).toBeTruthy()
    expect(screen.getByText('Fabricator’s files and settings in it')).toBeTruthy()
    expect(screen.getByText(/only removes the federated credentials/)).toBeTruthy()
    expect(screen.queryByText('GitHub repository'), 'nothing deletes the repository').toBeNull()
    expect(screen.queryByText(/Grant GitHub access/)).toBeNull()

    expect(abandonSteps(plan.items).map((s) => s.id)).toEqual(['check', 'trust', 'fabric', 'cleanup', 'local'])
    expect(stillThere(plan.items[0], workspace)).toBe(true)
    const removed = { ...workspace, setup: { ...workspace.setup!, completed: ['github', 'fabric', 'identity', 'access', 'files'] } }
    expect(stillThere(plan.items[0], removed), 'removing the credentials takes trust off the record').toBe(false)
    expect(stillThere(plan.items[2], workspace)).toBe(true)
  })
})

describe('single sign-on', () => {
  const sso: TeamProblem = {
    step: 'github',
    kind: 'sso',
    message:
      'Open microsoft/rayfin-team-apps: The microsoft organization requires single sign-on, and the GitHub CLI’s sign-in for amy_contoso isn’t authorized for it yet.',
    guidance:
      'GitHub lets the GitHub CLI into the organization only when you sign it in during a single sign-on session. In your browser, stay signed in to github.com as amy_contoso: select Open single sign-on and continue with your work account, then select Sign in to GitHub again and finish in the terminal and browser. Then try again.',
    link: { label: 'Open single sign-on', url: 'https://github.com/orgs/microsoft/sso' }
  }

  it('starts a single sign-on session and signs the account in again when setup can’t open the repository', async () => {
    const openExternal = vi.fn()
    const create = vi.fn(() => Promise.resolve({ ok: false, error: sso.message, problem: sso }))
    const githubSignIn = vi.fn<(signedIn: boolean, deleteRepo?: boolean, account?: string) => Promise<{ ok: boolean }>>(
      () => Promise.resolve({ ok: true })
    )
    install({ create, githubSignIn, repos: vi.fn(() => Promise.resolve({ ok: true, repos: [] })) })
    ;(window as unknown as { api: { openExternal: unknown } }).api.openExternal = openExternal
    await openCreate()
    await act(async () => fireEvent.click(screen.getByRole('radio', { name: 'Existing repository' })))
    fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'microsoft/rayfin-team-apps' } })
    await act(async () => fireEvent.click(createButton()))
    expect(screen.getByText(/requires single sign-on/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Open single sign-on/ }))
    expect(openExternal).toHaveBeenCalledWith('https://github.com/orgs/microsoft/sso')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sign in to GitHub again' })))
    // The account the workspace is set up as, not whichever the CLI has active.
    expect(githubSignIn).toHaveBeenCalledWith(true, false, 'amy_contoso')
    expect(screen.getByText(/Finish signing in in the terminal window/)).toBeTruthy()
    // The form stays as it was, so trying again is one click.
    expect((screen.getByLabelText('Repository') as HTMLInputElement).value).toBe('microsoft/rayfin-team-apps')
    expect(createButton().disabled).toBe(false)
  })

  it('says why the sign-in couldn’t start', async () => {
    const githubSignIn = vi.fn(() => Promise.resolve({ ok: false, error: 'The GitHub CLI (gh) isn’t installed.' }))
    install({
      create: vi.fn(() => Promise.resolve({ ok: false, error: sso.message, problem: sso })),
      githubSignIn,
      repos: vi.fn(() => Promise.resolve({ ok: true, repos: [] }))
    })
    await openCreate()
    await act(async () => fireEvent.click(screen.getByRole('radio', { name: 'Existing repository' })))
    fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'microsoft/rayfin-team-apps' } })
    await act(async () => fireEvent.click(createButton()))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sign in to GitHub again' })))
    expect(screen.getByText('The GitHub CLI (gh) isn’t installed.')).toBeTruthy()
    expect(screen.queryByText(/Finish signing in/)).toBeNull()
  })

  it('offers both when joining, too', async () => {
    const openExternal = vi.fn()
    const githubSignIn = vi.fn<(signedIn: boolean, deleteRepo?: boolean, account?: string) => Promise<{ ok: boolean }>>(
      () => Promise.resolve({ ok: true })
    )
    ;(window as unknown as { api: unknown }).api = {
      openExternal,
      team: {
        envStatus: vi.fn(() => Promise.resolve(env)),
        joinOptions: vi.fn(() => Promise.resolve({ ok: true, invitations: [], discovered: [] })),
        // Without a link, the sign-in alone still shows.
        join: vi.fn(() => Promise.resolve({ ok: false, error: sso.message, problem: { ...sso, link: undefined } })),
        githubSignIn,
        onDiagnosis: vi.fn(() => () => {}),
        diagnose: vi.fn(() => new Promise(() => {}))
      }
    }
    await act(async () => {
      render(<JoinTeamWorkspaceModal onClose={() => {}} onJoined={() => {}} />)
    })
    fireEvent.change(screen.getByPlaceholderText(/owner\/repository/), { target: { value: 'microsoft/rayfin-team-apps' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Join' })))
    expect(screen.getByText(/stay signed in to github.com as amy_contoso/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Open single sign-on/ })).toBeNull()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sign in to GitHub again' })))
    expect(githubSignIn).toHaveBeenCalledWith(true, false, 'amy_contoso')
    expect(openExternal).not.toHaveBeenCalled()
  })
})
