import { describe, expect, it } from 'vitest'
import type { StudioProject } from '@shared/ipc'
import { fabricWorkspaceUrl, recentWorkspaces } from './fabric'

/**
 * The footer workspace link deep-links to the Fabric portal using the workspace
 * GUID recorded in the deployment file (`fabricWorkspaceId`). Guards the exact
 * `groups/{id}/` URL shape and the GUID-only guard that keeps a pre-reconcile
 * display name from producing a broken link.
 */
describe('fabricWorkspaceUrl', () => {
  it('builds a Fabric portal groups deep link from a workspace GUID', () => {
    expect(fabricWorkspaceUrl('de0fcf1a-8c94-46cf-a029-650b2e87f172')).toBe(
      'https://app.fabric.microsoft.com/groups/de0fcf1a-8c94-46cf-a029-650b2e87f172/'
    )
  })

  it('is case-insensitive and trims surrounding whitespace', () => {
    expect(fabricWorkspaceUrl('  DE0FCF1A-8C94-46CF-A029-650B2E87F172  ')).toBe(
      'https://app.fabric.microsoft.com/groups/DE0FCF1A-8C94-46CF-A029-650B2E87F172/'
    )
  })

  it('returns undefined for a non-GUID workspace (e.g. a display name)', () => {
    expect(fabricWorkspaceUrl('Rayfin Apps')).toBeUndefined()
  })

  it('returns undefined when the id is missing or empty', () => {
    expect(fabricWorkspaceUrl(undefined)).toBeUndefined()
    expect(fabricWorkspaceUrl('')).toBeUndefined()
    expect(fabricWorkspaceUrl('   ')).toBeUndefined()
  })
})

describe('recentWorkspaces', () => {
  const app = (id: string, workspace?: string, at?: string, extra: Partial<StudioProject> = {}): StudioProject => ({
    id,
    name: id,
    path: `C:\\apps\\${id}`,
    addedAt: '2026-09-01T00:00:00Z',
    workspace,
    lastDeploy: at ? { status: 'success', at } : undefined,
    ...extra
  })

  it('lists each workspace your apps use once, the most recently used first', () => {
    expect(
      recentWorkspaces([
        app('a', 'ws-1', '2026-10-01T09:00:00Z'),
        app('b', 'ws-2', '2026-10-09T09:00:00Z'),
        app('c', 'ws-1', '2026-10-10T09:00:00Z'),
        app('d', 'ws-3')
      ])
    ).toEqual(['ws-1', 'ws-2', 'ws-3'])
  })

  it('leaves out team apps and apps without a workspace', () => {
    expect(
      recentWorkspaces([
        app('a', 'ws-team', '2026-10-09T09:00:00Z', { team: {} as StudioProject['team'] }),
        app('b', undefined, '2026-10-09T09:00:00Z'),
        app('c', '  ', '2026-10-09T09:00:00Z'),
        app('d', 'ws-mine', '2026-10-01T09:00:00Z')
      ])
    ).toEqual(['ws-mine'])
  })
})
