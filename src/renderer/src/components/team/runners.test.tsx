import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { TeamEnvStatus, TeamRunnerInfo, TeamRunStatus, TeamWorkspace } from '@shared/ipc'
import { OverlayProvider } from '../../overlay'
import CreateTeamWorkspaceModal from './CreateTeamWorkspaceModal'
import TeamDeployCard from './TeamDeployCard'
import WorkspacePanel from './map/WorkspacePanel'
import { describeRunner, draftRunner, runnerDraft, runnerDraftReady, runnerSummary } from './RunnerFields'
import { waitingStep } from './runProgress'

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

const env: TeamEnvStatus = {
  enabled: true,
  ghInstalled: true,
  ghSignedIn: true,
  ghUser: 'octo',
  ghMissingScopes: [],
  ghCanDeleteRepos: false,
  ghAccounts: [{ login: 'octo', active: true, signedIn: true, missingScopes: [], canDeleteRepos: false }],
  azSignedIn: true
}

function install(team: Record<string, unknown>): void {
  ;(window as unknown as { api: unknown }).api = {
    openExternal: vi.fn(),
    team: {
      envStatus: vi.fn(() => Promise.resolve(env)),
      onProgress: vi.fn(() => () => {}),
      onDiagnosis: vi.fn(() => () => {}),
      diagnose: vi.fn(() => new Promise(() => {})),
      cancel: vi.fn(() => Promise.resolve(true)),
      ...team
    }
  }
}

describe('runner choices', () => {
  it('turn into what the pipeline saves, and back', () => {
    expect(draftRunner(runnerDraft())).toEqual({})
    expect(draftRunner({ kind: 'group', group: ' deployers ', labels: 'linux, , x64' })).toEqual({
      group: 'deployers',
      labels: ['linux', 'x64']
    })
    expect(draftRunner({ kind: 'labels', group: 'ignored', labels: 'self-hosted,linux' })).toEqual({
      labels: ['self-hosted', 'linux']
    })
    expect(runnerDraft({ group: 'deployers', labels: ['linux'] })).toEqual({ kind: 'group', group: 'deployers', labels: 'linux' })
    expect(runnerDraft({ labels: ['self-hosted', 'linux'] }).kind).toBe('labels')
    expect(runnerDraftReady({ kind: 'group', group: ' ', labels: 'linux' })).toBe(false)
    expect(runnerDraftReady({ kind: 'labels', group: '', labels: ' , ' })).toBe(false)
    expect(runnerDraftReady(runnerDraft())).toBe(true)
    expect(describeRunner({ group: 'deployers', labels: ['linux'] })).toBe('Runner group deployers, labeled linux')
    expect(describeRunner({ labels: ['self-hosted'] })).toBe('Runners labeled self-hosted')
    expect(describeRunner({})).toBe('GitHub-hosted runners')
  })

  it('are summarized from the repository, then the organization', () => {
    const info = (over: Partial<TeamRunnerInfo>): TeamRunnerInfo => ({ ok: true, ...over })
    expect(runnerSummary(info({})).title).toBe('GitHub-hosted runners')
    expect(runnerSummary(info({ organization: { value: '{"group":"org"}', runner: { group: 'org' } } }))).toEqual({
      title: 'Runner group org',
      detail: 'Your organization chose these runners.',
      invalid: false
    })
    const both = info({
      repository: { value: '["self-hosted"]', runner: { labels: ['self-hosted'] } },
      organization: { value: '{"group":"org"}', runner: { group: 'org' } }
    })
    expect(runnerSummary(both).title).toBe('Runners labeled self-hosted')
    const broken = runnerSummary(info({ repository: { value: 'my-runner' } }))
    expect(broken.invalid).toBe(true)
    expect(broken.detail).toContain('my-runner')
  })
})

describe('CreateTeamWorkspaceModal runners', () => {
  it('creates the workspace on the runner group chosen under Advanced options', async () => {
    const create = vi.fn(() => new Promise(() => {}))
    install({
      owners: vi.fn(() => Promise.resolve({ ok: true, owners: [{ login: 'contoso', isOrg: true }] })),
      capacities: vi.fn(() =>
        Promise.resolve({ ok: true, capacities: [{ id: 'cap1', displayName: 'F4', kind: 'fabric', eligible: true }] })
      ),
      create
    })
    await act(async () => {
      render(
        <OverlayProvider>
          <CreateTeamWorkspaceModal onClose={() => {}} onChanged={() => {}} />
        </OverlayProvider>
      )
    })
    fireEvent.change(screen.getByPlaceholderText('Sales team apps'), { target: { value: 'Sales apps' } })
    const createButton = screen.getByRole('button', { name: 'Create workspace' }) as HTMLButtonElement
    expect(createButton.disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Advanced options' }))
    const where = screen.getByLabelText('Where the pipeline runs') as HTMLSelectElement
    expect(where.value).toBe('hosted')
    fireEvent.change(where, { target: { value: 'group' } })
    // A runner group needs its name.
    expect(createButton.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Runner group name'), { target: { value: 'deployers' } })
    expect(createButton.disabled).toBe(false)
    await act(async () => fireEvent.click(createButton))
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Sales apps', owner: 'contoso', runner: { group: 'deployers', labels: [] } }),
      expect.any(String)
    )
  })

  it('leaves the runners to the organization unless the owner picks some', async () => {
    const create = vi.fn(() => new Promise(() => {}))
    install({
      owners: vi.fn(() => Promise.resolve({ ok: true, owners: [{ login: 'octo', isOrg: false }] })),
      capacities: vi.fn(() =>
        Promise.resolve({ ok: true, capacities: [{ id: 'cap1', displayName: 'F4', kind: 'fabric', eligible: true }] })
      ),
      create
    })
    await act(async () => {
      render(
        <OverlayProvider>
          <CreateTeamWorkspaceModal onClose={() => {}} onChanged={() => {}} />
        </OverlayProvider>
      )
    })
    fireEvent.change(screen.getByPlaceholderText('Sales team apps'), { target: { value: 'Sales apps' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create workspace' })))
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ runner: undefined }), expect.any(String))
  })

  it('after no runner ran the pipeline, saves the runners chosen and retries', async () => {
    const workspace: TeamWorkspace = {
      id: 'w1',
      name: 'Sales',
      repo: 'contoso/sales',
      defaultBranch: 'main',
      dir: 'C:/team',
      role: 'owner',
      addedAt: '',
      account: 'octo',
      setup: {
        request: { name: 'Sales', owner: 'contoso', capacityId: 'cap1' },
        completed: ['github', 'files', 'clone'],
        done: false
      }
    }
    const resumeSetup = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        workspace,
        problem: {
          step: 'verify',
          kind: 'runner',
          message: 'No runner picked up the pipeline’s verification run in 6 minutes.',
          guidance: 'Choose your organization’s runners under Where the pipeline runs, then try again.'
        }
      })
      .mockResolvedValueOnce({ ok: true, workspace })
    const setRunner = vi.fn(() => Promise.resolve({ ok: true, workspace }))
    install({ resumeSetup, setRunner })
    await act(async () => {
      render(
        <OverlayProvider>
          <CreateTeamWorkspaceModal resume={workspace} onClose={() => {}} onChanged={() => {}} />
        </OverlayProvider>
      )
    })
    expect(resumeSetup).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/No runner picked up/)).toBeTruthy()
    const retry = screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement
    fireEvent.change(screen.getByLabelText('Where the pipeline runs'), { target: { value: 'labels' } })
    expect(retry.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Runner labels'), { target: { value: 'self-hosted, linux' } })
    expect(retry.disabled).toBe(false)
    await act(async () => fireEvent.click(retry))
    expect(setRunner).toHaveBeenCalledWith('w1', { labels: ['self-hosted', 'linux'] })
    expect(resumeSetup).toHaveBeenCalledTimes(2)
    expect(screen.getByText(/is ready/)).toBeTruthy()
  })

  it('keeps the choice open when saving it fails', async () => {
    const workspace: TeamWorkspace = {
      id: 'w1',
      name: 'Sales',
      repo: 'contoso/sales',
      defaultBranch: 'main',
      dir: 'C:/team',
      role: 'owner',
      addedAt: '',
      account: 'octo',
      setup: {
        request: { name: 'Sales', owner: 'contoso', capacityId: 'cap1', runner: { group: 'old' } },
        completed: [],
        done: false
      }
    }
    const resumeSetup = vi.fn(() =>
      Promise.resolve({ ok: false, workspace, problem: { step: 'verify', kind: 'runner', message: 'No runner picked up the run.' } })
    )
    const setRunner = vi.fn(() => Promise.resolve({ ok: false, error: 'Only the workspace’s owners can change its settings.' }))
    install({ resumeSetup, setRunner })
    await act(async () => {
      render(
        <OverlayProvider>
          <CreateTeamWorkspaceModal resume={workspace} onClose={() => {}} onChanged={() => {}} />
        </OverlayProvider>
      )
    })
    // It starts from the choice setup used.
    expect((screen.getByLabelText('Runner group name') as HTMLInputElement).value).toBe('old')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })))
    expect(setRunner).toHaveBeenCalledWith('w1', { group: 'old', labels: [] })
    expect(resumeSetup).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Only the workspace’s owners can change its settings.')).toBeTruthy()
    expect(screen.getByLabelText('Where the pipeline runs')).toBeTruthy()
  })
})

describe('WorkspacePanel pipeline runners', () => {
  const workspace: TeamWorkspace = {
    id: 'w1',
    name: 'Sales',
    repo: 'contoso/sales',
    defaultBranch: 'main',
    dir: 'C:/team',
    role: 'owner',
    addedAt: '',
    account: 'octo'
  }

  it('shows where the pipeline runs and changes it (owners)', async () => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, organization: { value: '{"group":"org-runners"}', runner: { group: 'org-runners' } } })
      .mockResolvedValue({
        ok: true,
        repository: { value: '{"group":"deployers"}', runner: { group: 'deployers' } },
        organization: { value: '{"group":"org-runners"}', runner: { group: 'org-runners' } }
      })
    const setRunner = vi.fn(() => Promise.resolve({ ok: true, workspace }))
    install({
      members: vi.fn(() => Promise.resolve({ ok: true, members: [], canManage: true })),
      health: vi.fn(() => Promise.resolve({ ok: true, items: [] })),
      runner,
      setRunner
    })
    await act(async () => {
      render(<WorkspacePanel workspace={workspace} initialTab="settings" onClose={() => {}} onChanged={() => {}} onGone={() => {}} />)
    })
    const section = screen.getByRole('heading', { name: 'Where the pipeline runs' }).closest('section') as HTMLElement
    expect(section.textContent).toContain('Runner group org-runners')
    expect(section.textContent).toContain('Your organization chose these runners.')
    await act(async () => fireEvent.click(within(section).getByRole('button', { name: 'Change' })))
    const where = within(section).getByLabelText('Where the pipeline runs') as HTMLSelectElement
    expect(where.options[0].textContent).toBe('Your organization’s choice: Runner group org-runners')
    fireEvent.change(where, { target: { value: 'group' } })
    const save = within(section).getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(within(section).getByLabelText('Runner group name'), { target: { value: 'deployers' } })
    await act(async () => fireEvent.click(save))
    expect(setRunner).toHaveBeenCalledWith('w1', { group: 'deployers', labels: [] })
    expect(screen.getByText('Pipeline runs that start from now on use these runners.')).toBeTruthy()
    expect(section.textContent).toContain('Runner group deployers')
    expect(section.textContent).toContain('Every pipeline run uses these runners.')
  })

  it('isn’t shown to members, who can’t read the pipeline’s settings', async () => {
    const runner = vi.fn()
    install({
      members: vi.fn(() => Promise.resolve({ ok: true, members: [], canManage: false })),
      health: vi.fn(() => Promise.resolve({ ok: true, items: [] })),
      runner
    })
    await act(async () => {
      render(
        <WorkspacePanel
          workspace={{ ...workspace, role: 'member' }}
          initialTab="settings"
          onClose={() => {}}
          onChanged={() => {}}
          onGone={() => {}}
        />
      )
    })
    expect(screen.queryByRole('heading', { name: 'Where the pipeline runs' })).toBeNull()
    expect(runner).not.toHaveBeenCalled()
  })
})

describe('a run no runner picks up', () => {
  const run = (minutes: number): TeamRunStatus => ({
    id: 9,
    kind: 'preview',
    status: 'queued',
    url: 'https://github.com/o/r/actions/runs/9',
    sha: 'a',
    startedAt: new Date(Date.now() - minutes * 60_000).toISOString(),
    steps: []
  })

  it('says it is still waiting for a runner after a few minutes', () => {
    const now = Date.now()
    expect(waitingStep(run(1), now)).toBe('Waiting for the pipeline to start')
    expect(waitingStep(run(4), now)).toBe('Still waiting for a runner')
    expect(waitingStep({ ...run(4), status: 'in_progress' }, now)).toBeUndefined()
    ;(window as unknown as { api: unknown }).api = { openExternal: vi.fn() }
    render(<TeamDeployCard run={run(4)} />)
    const card = screen.getByRole('status')
    expect(card.textContent).toContain('Still waiting for a runner')
    expect(card.textContent).toContain('Manage → Settings → Where the pipeline runs')
  })
})
