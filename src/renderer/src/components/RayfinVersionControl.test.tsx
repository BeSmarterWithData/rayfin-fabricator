import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { RayfinVersionInfo } from '@shared/ipc'
import RayfinVersionControl from './RayfinVersionControl'

afterEach(cleanup)

const current: RayfinVersionInfo = {
  version: '1.36.2',
  latest: '1.36.2',
  upgradeAvailable: false,
  packages: [
    {
      name: '@microsoft/rayfin-cli',
      kind: 'cli',
      installed: '1.36.2',
      latest: '1.36.2',
      upgradable: false
    }
  ]
}

describe('RayfinVersionControl', () => {
  it('stays out of the status bar until there is an update', () => {
    const { container, rerender } = render(<RayfinVersionControl info={null} onUpdate={vi.fn()} />)
    expect(container.firstChild).toBeNull()

    rerender(<RayfinVersionControl info={current} onUpdate={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it('offers the update when a newer release is out', () => {
    const onUpdate = vi.fn()
    const outdated: RayfinVersionInfo = {
      version: '1.35.1',
      latest: '1.36.2',
      upgradeAvailable: true,
      packages: [
        {
          name: '@microsoft/rayfin-cli',
          kind: 'cli',
          installed: '1.35.1',
          latest: '1.36.2',
          upgradable: true
        }
      ]
    }
    render(<RayfinVersionControl info={outdated} onUpdate={onUpdate} />)

    fireEvent.click(screen.getByRole('button', { name: /Rayfin v1\.35\.1/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Update with Copilot' }))
    expect(onUpdate).toHaveBeenCalledWith(outdated)
  })
})
