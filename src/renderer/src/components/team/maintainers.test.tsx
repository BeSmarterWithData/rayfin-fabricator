import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TeamMembersResult, TeamWorkspace } from '@shared/ipc'
import WorkspacePanel from './map/WorkspacePanel'

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

const workspace: TeamWorkspace = {
  id: 'w1',
  name: 'Rayfin team apps',
  repo: 'azure-data/rayfin-team-apps',
  defaultBranch: 'main',
  dir: 'C:/team',
  role: 'owner',
  addedAt: '',
  account: 'sapatney_microsoft'
}

/** The panel for an owner; `admin` is whether GitHub lets them add and remove people. */
async function openPanel(admin: boolean, tab: 'members' | 'settings'): Promise<void> {
  const members: TeamMembersResult = {
    ok: true,
    members: [{ login: 'sapatney_microsoft', role: 'owner', pending: false }],
    canManage: admin
  }
  ;(window as unknown as { api: unknown }).api = {
    openExternal: vi.fn(),
    team: {
      members: vi.fn(() => Promise.resolve(members)),
      health: vi.fn(() => Promise.resolve({ ok: true, items: [] })),
      runner: vi.fn(() => Promise.resolve({ ok: true })),
      fabricAccess: vi.fn(() => Promise.resolve({ ok: true, people: [] })),
      onProgress: vi.fn(() => () => {}),
      onDiagnosis: vi.fn(() => () => {})
    }
  }
  await act(async () => {
    render(<WorkspacePanel workspace={workspace} initialTab={tab} onClose={() => {}} onChanged={() => {}} onGone={() => {}} />)
  })
}

describe('owners with the Maintain role', () => {
  it('manage the pipeline and settings', async () => {
    await openPanel(false, 'settings')
    expect(screen.getByRole('heading', { name: 'Where the pipeline runs' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Check the pipeline' })).toBeTruthy()
    expect((screen.getByLabelText('Require a review before publishing') as HTMLInputElement).disabled).toBe(false)
    expect(screen.getByRole('tab', { name: 'App access' })).toBeTruthy()
  })

  it('learn that only admins can add people or delete the workspace', async () => {
    await openPanel(false, 'members')
    expect(screen.queryByRole('button', { name: 'Send invitation' })).toBeNull()
    expect(
      screen.getByText(
        'GitHub only lets admins of azure-data/rayfin-team-apps add or remove people, and you have the Maintain role. Ask one of its admins to add your teammates with the Write role.'
      )
    ).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByRole('tab', { name: 'Settings' })))
    expect(screen.queryByRole('button', { name: 'Delete workspace…' })).toBeNull()
    expect(screen.getByText(/Deleting the workspace archives its repository, which GitHub only lets its admins do\./)).toBeTruthy()
  })

  it('aren’t told that when they’re admins', async () => {
    await openPanel(true, 'members')
    expect(screen.getByRole('button', { name: 'Send invitation' })).toBeTruthy()
    expect(screen.queryByText(/you have the Maintain role/)).toBeNull()
    await act(async () => fireEvent.click(screen.getByRole('tab', { name: 'Settings' })))
    expect(screen.getByRole('button', { name: 'Delete workspace…' })).toBeTruthy()
    expect(screen.queryByText(/which GitHub only lets its admins do/)).toBeNull()
  })
})
