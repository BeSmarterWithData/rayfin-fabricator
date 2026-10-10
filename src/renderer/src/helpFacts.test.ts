import { describe, expect, it } from 'vitest'
import type { AuthStatus, DoctorReport, StudioProject } from '@shared/ipc'
import { accountFacts, setupFacts, workbenchFacts } from './helpFacts'

function tool(id: string, satisfied: boolean, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id === 'az' ? 'Azure CLI' : id,
    found: satisfied,
    satisfied,
    version: satisfied ? '1.0.0' : null,
    installHint: '',
    autoInstallable: true,
    required: true,
    ...extra
  } as DoctorReport['tools'][number]
}

function doctor(tools: DoctorReport['tools']): DoctorReport {
  return { tools, ready: tools.filter((t) => t.required).every((t) => t.satisfied) }
}

function auth(copilot: boolean, az: boolean): AuthStatus {
  return {
    copilot: { signedIn: copilot, user: copilot ? 'octocat' : undefined },
    rayfin: { signedIn: az },
    az: { signedIn: az, user: az ? 'user@contoso.com' : undefined }
  } as AuthStatus
}

describe('setupFacts', () => {
  it('says setup is complete when everything is green', () => {
    const facts = setupFacts(doctor([tool('node', true), tool('git', true)]), auth(true, true))
    expect(facts.some((f) => f.includes('Setup is complete'))).toBe(true)
    expect(facts.some((f) => f.includes('All 2 required tools are installed'))).toBe(true)
    expect(facts.some((f) => f.includes('Signed in to GitHub Copilot as octocat'))).toBe(true)
  })

  // The bug that prompted all of this: a green setup screen, and the assistant
  // reporting old resolved errors as if they were live.
  it('never implies trouble when nothing is wrong', () => {
    const facts = setupFacts(doctor([tool('node', true)]), auth(true, true))
    expect(facts.some((f) => f.includes('not finished'))).toBe(false)
    expect(facts.some((f) => f.includes('not installed'))).toBe(false)
    expect(facts.some((f) => f.includes('Not signed in'))).toBe(false)
  })

  it('names each missing tool and keeps the ones that work', () => {
    const facts = setupFacts(
      doctor([tool('node', true), tool('git', false), tool('az', false)]),
      auth(true, false)
    )
    expect(facts).toContain('git is not installed yet.')
    expect(facts).toContain('Azure CLI is not installed yet.')
    expect(facts).toContain('Installed and working: node.')
    expect(facts.some((f) => f.includes('Setup is not finished'))).toBe(true)
  })

  it('distinguishes a broken version check from a missing tool', () => {
    const facts = setupFacts(
      doctor([tool('node', false, { found: true, checkError: 'exit 1' })]),
      auth(true, true)
    )
    expect(facts).toContain('node is installed but its version check is failing.')
  })

  it('leads with being offline, because it explains the rest', () => {
    const facts = setupFacts(doctor([tool('node', false)]), auth(false, false), { online: false })
    expect(facts[0]).toBe('This computer is currently offline.')
  })

  it('does not claim a tool is missing before the check has run', () => {
    const facts = setupFacts(null, auth(true, true))
    expect(facts).toContain('The tool check has not finished running yet.')
    expect(facts.some((f) => f.includes('not installed'))).toBe(false)
  })

  it('mentions optional tools only when they are present', () => {
    const present = setupFacts(
      doctor([tool('node', true), tool('gh', true, { required: false })]),
      auth(true, true)
    )
    expect(present.some((f) => f.includes('Also installed (optional): gh.'))).toBe(true)

    const absent = setupFacts(
      doctor([tool('node', true), tool('gh', false, { required: false })]),
      auth(true, true)
    )
    expect(absent.some((f) => f.includes('optional'))).toBe(false)
  })
})

describe('accountFacts', () => {
  it('treats an unchecked account as unknown, not signed out', () => {
    const status = { copilot: { signedIn: false, checking: true }, az: { signedIn: true } }
    const facts = accountFacts(status as AuthStatus)
    expect(facts).toContain('The GitHub Copilot account is still being checked.')
    expect(facts.some((f) => f === 'Not signed in to GitHub Copilot.')).toBe(false)
  })

  it('reports both accounts as signed out when there is no status at all', () => {
    const facts = accountFacts(null)
    expect(facts).toContain('Not signed in to GitHub Copilot.')
    expect(facts).toContain('Not signed in to the Microsoft account.')
  })
})

describe('workbenchFacts', () => {
  const project = {
    id: 'p1',
    name: 'Expenses',
    path: 'C:\\apps\\expenses',
    addedAt: '2026-01-01T00:00:00Z'
  } as StudioProject

  it('says which app is open and that it is personal', () => {
    const facts = workbenchFacts(project)
    expect(facts[0]).toContain('"Expenses"')
    expect(facts[0]).toContain('personal app')
  })

  it('marks a team app as living in a team workspace', () => {
    const facts = workbenchFacts(project, { team: true })
    expect(facts[0]).toContain('team workspace')
  })

  it('names the workspace an app was deployed to', () => {
    const facts = workbenchFacts({
      ...project,
      lastDeploy: { url: 'https://app.example' },
      workspaceName: 'Sales'
    } as StudioProject)
    expect(facts.some((f) => f.includes('deployed to the Sales workspace'))).toBe(true)
  })

  it('calls out an app that has never been deployed', () => {
    const facts = workbenchFacts({ ...project, awaitingFirstDeploy: true } as StudioProject)
    expect(facts.some((f) => f.includes('never been deployed'))).toBe(true)
  })

  it('reports a running preview and an in-flight deploy', () => {
    const facts = workbenchFacts(project, {
      previewUrl: 'http://localhost:5173',
      deploying: true
    })
    expect(facts.some((f) => f.includes('A deploy is running right now.'))).toBe(true)
    expect(facts.some((f) => f.includes('local preview'))).toBe(true)
  })

  it('says the last deploy failed while that is still the latest word', () => {
    const failed = workbenchFacts(project, { deployFailed: true })
    expect(failed.some((f) => f.includes('most recent deploy of "Expenses" failed'))).toBe(true)
    // A new deploy under way supersedes it.
    const retrying = workbenchFacts(project, { deployFailed: true, deploying: true })
    expect(retrying.some((f) => f.includes('failed'))).toBe(false)
    expect(workbenchFacts(project).some((f) => f.includes('failed'))).toBe(false)
  })

  it('handles no open app', () => {
    expect(workbenchFacts(null, { projectCount: 3 })[0]).toContain('list of 3 app(s)')
    expect(workbenchFacts(null)[0]).toContain('none have been created')
  })
})

describe('knowing which screen the user is on', () => {
  const project = {
    id: 'p1',
    name: 'Expenses',
    path: 'C:\\apps\\expenses',
    addedAt: '2026-01-01T00:00:00Z'
  } as StudioProject

  // Help offered "Open my projects" while the project list was already on
  // screen; pressing it did nothing. It has to know where the user is.
  it('says when the user is already looking at their list', () => {
    const facts = workbenchFacts(project, { onHome: true })
    expect(facts[0]).toContain('looking at their list of apps')
  })

  it('does not say that while they are working inside an app', () => {
    const facts = workbenchFacts(project)
    expect(facts.some((f) => f.includes('looking at their list'))).toBe(false)
  })

  it('describes an empty list as nothing to open', () => {
    expect(workbenchFacts(null)[0]).toContain('none have been created')
  })
})
