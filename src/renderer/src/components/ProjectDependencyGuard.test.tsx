import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StudioProject } from '@shared/ipc'
import { OverlayProvider } from '../overlay'
import ProjectDependencyGuard from './ProjectDependencyGuard'

function makeProject(): StudioProject {
  return {
    id: 'project-1',
    name: 'Cloned app',
    path: 'C:/projects/cloned-app',
    addedAt: '2024-01-01T00:00:00.000Z'
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function installApi(ensureDependencies: ReturnType<typeof vi.fn>): void {
  ;(window as unknown as { api: unknown }).api = {
    projects: { ensureDependencies }
  }
}

function renderGuard(onSwitchProjects = vi.fn(), onReadyChange?: ReturnType<typeof vi.fn>): void {
  render(
    <OverlayProvider>
      <ProjectDependencyGuard
        project={makeProject()}
        onSwitchProjects={onSwitchProjects}
        hidden={false}
        onReadyChange={onReadyChange}
      >
        <p>Project tools are ready</p>
      </ProjectDependencyGuard>
    </OverlayProvider>
  )
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('ProjectDependencyGuard', () => {
  it('waits for dependency preparation before exposing project tools', async () => {
    const preparation = deferred<{ ok: boolean }>()
    const ensureDependencies = vi.fn(() => preparation.promise)
    installApi(ensureDependencies)

    renderGuard()

    expect(await screen.findByRole('status', { name: 'Preparing Cloned app' })).toBeTruthy()
    expect(screen.queryByText('Project tools are ready')).toBeNull()
    expect(ensureDependencies).toHaveBeenCalledWith('project-1')

    await act(async () => {
      preparation.resolve({ ok: true })
    })

    expect(await screen.findByText('Project tools are ready')).toBeTruthy()
  })

  it('keeps a failed install recoverable with a retry', async () => {
    const ensureDependencies = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'npm install failed (exit code 1).' })
      .mockResolvedValueOnce({ ok: true })
    const onSwitchProjects = vi.fn()
    installApi(ensureDependencies)

    renderGuard(onSwitchProjects)

    expect(await screen.findByRole('alert', { name: 'Could not prepare Cloned app' })).toBeTruthy()
    expect(screen.getByText('npm install failed (exit code 1).')).toBeTruthy()
    screen.getByRole('button', { name: 'Retry installation' }).click()

    await waitFor(() => expect(ensureDependencies).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('Project tools are ready')).toBeTruthy()
  })

  it('reports readiness so chrome outside the guard can follow the same gate', async () => {
    const preparation = deferred<{ ok: boolean }>()
    installApi(vi.fn(() => preparation.promise))
    const onReadyChange = vi.fn()

    renderGuard(vi.fn(), onReadyChange)

    await screen.findByRole('status', { name: 'Preparing Cloned app' })
    expect(onReadyChange.mock.calls).toEqual([['project-1', false]])

    await act(async () => {
      preparation.resolve({ ok: true })
    })

    await screen.findByText('Project tools are ready')
    expect(onReadyChange).toHaveBeenLastCalledWith('project-1', true)
    cleanup()
    expect(onReadyChange).toHaveBeenLastCalledWith('project-1', false)
  })

  it('never reports a failed install as ready', async () => {
    installApi(vi.fn().mockResolvedValue({ ok: false, error: 'npm install failed (exit code 1).' }))
    const onReadyChange = vi.fn()

    renderGuard(vi.fn(), onReadyChange)

    expect(await screen.findByRole('alert', { name: 'Could not prepare Cloned app' })).toBeTruthy()
    expect(onReadyChange).not.toHaveBeenCalledWith('project-1', true)
    expect(onReadyChange).toHaveBeenLastCalledWith('project-1', false)
  })
})
