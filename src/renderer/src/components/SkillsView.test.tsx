import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { SkillInfo, StudioProject } from '@shared/ipc'
import { OverlayProvider } from '../overlay'
import SkillsView from './SkillsView'

/**
 * The Skills tab groups skills into sections (Rayfin's always-on skills, the
 * built-in catalog by category, "Your skill library" and "Added in this app").
 * Built-in and library skills switch on and off from their cards; everything
 * else happens in the details panel of the selected skill.
 */

const BASE_SKILL: SkillInfo = {
  id: 'rayfin',
  title: 'Rayfin essentials',
  description: 'core',
  icon: '◆',
  base: true,
  active: true
}
const CATALOG_SKILL: SkillInfo = {
  id: 'polished-ui',
  title: 'Polished, modern UI',
  description: 'A clean, consistent look.',
  icon: '✨',
  base: false,
  active: false,
  category: 'Look & feel'
}
const LIBRARY_SKILL: SkillInfo = {
  id: 'brand',
  title: 'Brand',
  description: 'Our brand',
  icon: '🎨',
  base: false,
  active: false,
  custom: true,
  library: true
}
const APP_SKILL: SkillInfo = {
  id: 'local-thing',
  title: 'Local Thing',
  description: 'app only',
  icon: '🧩',
  base: false,
  active: true,
  custom: true,
  promotable: true
}
/** The Universal template's own skill, named like a built-in one. */
const TEMPLATE_SKILL: SkillInfo = {
  id: 'data-modeling',
  title: 'Data modeling',
  description: 'Use when the app needs to store or read data.',
  icon: '🧩',
  base: false,
  active: true,
  custom: true
}

const SOURCE = `---
name: polished-ui
description: "Make the app look clean. Use when restyling. Triggers: UI, design, spacing"
---
# Polished, modern UI

## Layout
- Use a 4px spacing scale.
`

function installApi(list: SkillInfo[]): {
  skills: { list: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; source: ReturnType<typeof vi.fn> }
  customSkills: { promote: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }
} {
  const api = {
    skills: {
      list: vi.fn(() => Promise.resolve(list)),
      set: vi.fn(() => Promise.resolve({ ok: true, skills: list })),
      source: vi.fn(() => Promise.resolve({ ok: true, installed: true, content: SOURCE }))
    },
    customSkills: {
      list: vi.fn(() => Promise.resolve([])),
      promote: vi.fn(() => Promise.resolve({ ok: true, id: 'local-thing', library: [] })),
      remove: vi.fn(() => Promise.resolve({ ok: true, id: 'brand', library: [] }))
    },
    openExternal: vi.fn(() => Promise.resolve())
  }
  ;(window as unknown as { api: unknown }).api = api
  return api as unknown as ReturnType<typeof installApi>
}

async function renderView(onChanged: () => void = () => {}): Promise<void> {
  await act(async () => {
    render(
      <OverlayProvider>
        <SkillsView project={{ id: 'p1' } as unknown as StudioProject} onChanged={onChanged} />
      </OverlayProvider>
    )
  })
}

/** Select a skill's card and return its details panel. */
async function openDetails(title: string): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${title}`) }))
  return screen.findByRole('complementary', { name: `${title} details` })
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('SkillsView sections', () => {
  beforeEach(() => {
    installApi([BASE_SKILL, CATALOG_SKILL, LIBRARY_SKILL, APP_SKILL])
  })

  it('groups skills into always-on, catalog, library and app sections', async () => {
    await renderView()

    expect(await screen.findByRole('region', { name: 'Always on' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Look & feel' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Your skill library' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Added in this app' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New skill' })).toBeTruthy()
    // Built-in and library skills switch from their cards; Rayfin's and the app's own don't.
    expect(screen.getByRole('switch', { name: 'Use Polished, modern UI in this app' })).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Use Brand in this app' })).toBeTruthy()
    expect(screen.queryByRole('switch', { name: /Rayfin essentials/ })).toBeNull()
    expect(screen.queryByRole('switch', { name: /Local Thing/ })).toBeNull()
  })

  it('hides the library section when there are no library skills, keeping the add entry point', async () => {
    installApi([BASE_SKILL])
    await renderView()

    expect(await screen.findByRole('button', { name: 'New skill' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Your skill library' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Added in this app' })).toBeNull()
  })
})

describe('SkillsView actions', () => {
  it('turns a built-in skill on from its card', async () => {
    const api = installApi([BASE_SKILL, CATALOG_SKILL])
    const onChanged = vi.fn()
    await renderView(onChanged)

    fireEvent.click(await screen.findByRole('switch', { name: 'Use Polished, modern UI in this app' }))

    await waitFor(() => expect(api.skills.set).toHaveBeenCalledWith('p1', 'polished-ui', true))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(await screen.findByText('Turned on “Polished, modern UI”. Saved to this app.')).toBeTruthy()
    // Switching doesn't select the card.
    expect(screen.queryByRole('complementary', { name: 'Polished, modern UI details' })).toBeNull()
  })

  it('shows what a skill teaches and when Copilot uses it', async () => {
    const api = installApi([BASE_SKILL, CATALOG_SKILL])
    await renderView()

    const details = await openDetails('Polished, modern UI')
    await waitFor(() => expect(api.skills.source).toHaveBeenCalledWith('p1', 'polished-ui'))
    expect(await within(details).findByText('Make the app look clean. Use when restyling.')).toBeTruthy()
    const triggers = within(details).getByRole('list', { name: 'Trigger words' })
    expect(within(triggers).getAllByRole('listitem').map((el) => el.textContent)).toEqual(['UI', 'design', 'spacing'])
    expect(within(details).getByText('Use a 4px spacing scale.')).toBeTruthy()

    fireEvent.click(within(details).getByRole('button', { name: 'Close details' }))
    expect(screen.queryByRole('complementary', { name: 'Polished, modern UI details' })).toBeNull()
    expect(screen.getByRole('complementary', { name: 'About skills' })).toBeTruthy()
  })

  it('edits and deletes a library skill from its details', async () => {
    const api = installApi([BASE_SKILL, LIBRARY_SKILL])
    await renderView()

    const details = await openDetails('Brand')
    expect(within(details).getByRole('button', { name: 'Edit' })).toBeTruthy()
    fireEvent.click(within(details).getByRole('button', { name: 'Delete' }))

    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(api.customSkills.remove).toHaveBeenCalledWith('brand'))
  })

  it('saves a skill added in this app to the library and reloads', async () => {
    const api = installApi([BASE_SKILL, APP_SKILL])
    await renderView()

    const details = await openDetails('Local Thing')
    fireEvent.click(within(details).getByRole('button', { name: 'Save to library' }))

    await waitFor(() => expect(api.customSkills.promote).toHaveBeenCalledWith('p1', 'local-thing'))
    // Reloaded the project list (once on mount, once after promote).
    await waitFor(() => expect(api.skills.list).toHaveBeenCalledTimes(2))
  })

  it('doesn’t offer to save a skill whose name the library can’t take', async () => {
    installApi([BASE_SKILL, TEMPLATE_SKILL])
    await renderView()

    const details = await openDetails('Data modeling')
    expect(within(details).queryByRole('button', { name: 'Save to library' })).toBeNull()
    expect(within(details).getByText(/can’t be saved to your library/)).toBeTruthy()
    fireEvent.click(within(details).getByRole('button', { name: 'Remove' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByText(/Save it to your library/)).toBeNull()
  })

  it('removes a skill added in this app only after confirming', async () => {
    const api = installApi([BASE_SKILL, APP_SKILL])
    await renderView()

    const details = await openDetails('Local Thing')
    fireEvent.click(within(details).getByRole('button', { name: 'Remove' }))
    expect(api.skills.set).not.toHaveBeenCalled()

    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(api.skills.set).toHaveBeenCalledWith('p1', 'local-thing', false))
  })

  it('updates built-in skills that have a newer version', async () => {
    const outdated = { ...CATALOG_SKILL, active: true, outdated: true }
    const api = installApi([BASE_SKILL, outdated])
    await renderView()

    expect(await screen.findByText('Update available')).toBeTruthy()
    const overview = screen.getByRole('complementary', { name: 'About skills' })
    fireEvent.click(within(overview).getByRole('button', { name: 'Update it' }))

    await waitFor(() => expect(api.skills.set).toHaveBeenCalledWith('p1', 'polished-ui', true))
    expect(await screen.findByText('Updated 1 skill.')).toBeTruthy()
  })
})

describe('SkillsView search and filters', () => {
  beforeEach(() => {
    installApi([BASE_SKILL, CATALOG_SKILL, LIBRARY_SKILL, APP_SKILL])
  })

  it('narrows the grid to matching skills', async () => {
    await renderView()

    fireEvent.change(await screen.findByRole('textbox', { name: 'Search skills' }), { target: { value: 'brand' } })
    expect(screen.getByRole('button', { name: /^Brand/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Polished, modern UI/ })).toBeNull()

    fireEvent.change(screen.getByRole('textbox', { name: 'Search skills' }), { target: { value: 'nothing like it' } })
    const empty = screen.getByText('No skills match “nothing like it”').parentElement as HTMLElement
    fireEvent.click(within(empty).getByRole('button', { name: 'Clear search' }))
    expect(screen.getByRole('button', { name: /^Brand/ })).toBeTruthy()
  })

  it('shows only skills that are on, or off', async () => {
    await renderView()

    fireEvent.click(await screen.findByRole('radio', { name: /^On/ }))
    expect(screen.getByRole('button', { name: /^Local Thing/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Brand/ })).toBeNull()

    fireEvent.click(screen.getByRole('radio', { name: /^Off/ }))
    expect(screen.getByRole('button', { name: /^Brand/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Local Thing/ })).toBeNull()
  })
})
