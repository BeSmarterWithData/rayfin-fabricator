import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { SecretInfo, SecretsState, StudioProject } from '@shared/ipc'
import { OverlayProvider } from '../overlay'
import SecretsView from './SecretsView'
import { nameProblem, toSecretName } from './secrets/SecretDialog'

const OPENAI: SecretInfo = {
  name: 'OPENAI_KEY',
  description: 'Key for the chat function',
  declared: true,
  stored: true,
  createdAt: '2026-10-01T10:00:00Z',
  updatedAt: '2026-10-02T10:00:00Z'
}
const MISSING: SecretInfo = { name: 'STRIPE_KEY', declared: true, stored: false }

function ready(secrets: SecretInfo[], extra: Partial<SecretsState> = {}): SecretsState {
  return { status: 'ready', secrets, functionsEnabled: true, rayfinVersion: '1.36.2', ...extra }
}

function installApi(state: SecretsState) {
  const api = {
    secrets: {
      list: vi.fn(() => Promise.resolve(state)),
      set: vi.fn(() => Promise.resolve({ ok: true })),
      remove: vi.fn(() => Promise.resolve({ ok: true }))
    },
    openExternal: vi.fn(() => Promise.resolve())
  }
  ;(window as unknown as { api: unknown }).api = api
  return api
}

async function renderView(props: { onChanged?: () => void; onSendToChat?: (d: string, p: string) => void } = {}) {
  await act(async () => {
    render(
      <OverlayProvider>
        <SecretsView
          project={{ id: 'p1', lastDeploy: { url: 'https://app.example' } } as unknown as StudioProject}
          onChanged={props.onChanged ?? (() => {})}
          onSendToChat={props.onSendToChat}
        />
      </OverlayProvider>
    )
  })
}

async function openDetails(name: string): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${name}`) }))
  return screen.findByRole('complementary', { name: `${name} details` })
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('secret names', () => {
  it('turns typed text into UPPER_SNAKE_CASE', () => {
    expect(toSecretName('openai api-key')).toBe('OPENAI_API_KEY')
    expect(toSecretName('my.key!')).toBe('MY_KEY')
    expect(nameProblem('2FA_CODE')).toBe('Start the name with a letter.')
    expect(nameProblem('_X')).not.toBeNull()
    expect(nameProblem('OPENAI_KEY')).toBeNull()
    expect(nameProblem('')).toBeNull()
  })
})

describe('SecretsView', () => {
  it('lists secrets with their state, and how a function reads one', async () => {
    installApi(ready([OPENAI, MISSING]))
    const onSendToChat = vi.fn()
    await renderView({ onSendToChat })

    const list = await screen.findByRole('region', { name: 'Secrets' })
    expect(within(list).getByText('Set')).toBeTruthy()
    expect(within(list).getByText('No value')).toBeTruthy()

    const details = await openDetails('OPENAI_KEY')
    expect(within(details).getByText('ctx.Secrets.OPENAI_KEY')).toBeTruthy()
    expect(within(details).getByText(/^Hidden\./)).toBeTruthy()
    fireEvent.click(within(details).getByRole('button', { name: /Ask Copilot to use it/ }))
    expect(onSendToChat).toHaveBeenCalledTimes(1)
    const [label, prompt] = onSendToChat.mock.calls[0]
    expect(label).toBe('Use secret OPENAI_KEY')
    expect(prompt).toContain('ctx.Secrets.OPENAI_KEY')
    expect(prompt).toContain('Never hard-code its value')
  })

  it('adds a secret, sending the value only to the CLI call', async () => {
    const api = installApi(ready([OPENAI]))
    const onChanged = vi.fn()
    await renderView({ onChanged })

    fireEvent.click(await screen.findByRole('button', { name: 'New secret' }))
    const dialog = await screen.findByRole('dialog', { name: 'New secret' })
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'stripe secret key' } })
    expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('STRIPE_SECRET_KEY')
    const value = within(dialog).getByLabelText('Value') as HTMLInputElement
    expect(value.type).toBe('password')
    fireEvent.change(value, { target: { value: 'sk_live_123' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show value' }))
    expect(value.type).toBe('text')
    fireEvent.change(within(dialog).getByLabelText(/What it’s for/), { target: { value: 'Payments' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add secret' }))

    await waitFor(() =>
      expect(api.secrets.set).toHaveBeenCalledWith('p1', 'STRIPE_SECRET_KEY', 'sk_live_123', 'Payments')
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(await screen.findByText('Added STRIPE_SECRET_KEY. Its value is stored with your deployed app.')).toBeTruthy()
    expect(onChanged).toHaveBeenCalled()
    await waitFor(() => expect(api.secrets.list).toHaveBeenCalledTimes(2))
    // The value never shows up anywhere on the page afterwards.
    expect(document.body.textContent).not.toContain('sk_live_123')
  })

  it('won’t add a name functions can’t use', async () => {
    const api = installApi(ready([]))
    await renderView()

    // The empty list has its own "New secret" too.
    expect(await screen.findByText('No secrets yet')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: /New secret/ })[1])
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: '2fa code' } })
    fireEvent.change(within(dialog).getByLabelText('Value'), { target: { value: 'x' } })
    expect(within(dialog).getByText('Start the name with a letter.')).toBeTruthy()
    expect((within(dialog).getByRole('button', { name: 'Add secret' }) as HTMLButtonElement).disabled).toBe(true)
    expect(api.secrets.set).not.toHaveBeenCalled()
  })

  it('keeps the dialog open with the reason when saving fails', async () => {
    const api = installApi(ready([OPENAI]))
    api.secrets.set.mockResolvedValueOnce({ ok: false, error: 'Token expired.', signIn: true } as never)
    await renderView()

    const details = await openDetails('OPENAI_KEY')
    fireEvent.click(within(details).getByRole('button', { name: /Replace value/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Replace value' })
    // Replacing keeps the name, and rayfin.yml already describes it.
    expect(within(dialog).queryByLabelText('Name')).toBeNull()
    expect(within(dialog).queryByLabelText(/What it’s for/)).toBeNull()
    fireEvent.change(within(dialog).getByLabelText('Value'), { target: { value: 'sk-new' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace value' }))

    await waitFor(() => expect(api.secrets.set).toHaveBeenCalledWith('p1', 'OPENAI_KEY', 'sk-new', undefined))
    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toContain('Token expired.')
    expect(alert.textContent).toContain('Refresh Fabric authentication')
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('deletes a secret after confirming', async () => {
    const api = installApi(ready([OPENAI, MISSING]))
    await renderView()

    // A secret without a value has nothing to delete.
    const missing = await openDetails('STRIPE_KEY')
    expect(within(missing).queryByRole('button', { name: /Delete/ })).toBeNull()
    expect(within(missing).getByRole('button', { name: /Set value/ })).toBeTruthy()

    const details = await openDetails('OPENAI_KEY')
    fireEvent.click(within(details).getByRole('button', { name: /Delete/ }))
    const dialog = await screen.findByRole('dialog')
    expect(api.secrets.remove).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.secrets.remove).toHaveBeenCalledWith('p1', 'OPENAI_KEY'))
    expect(await screen.findByText('Deleted OPENAI_KEY.')).toBeTruthy()
  })

  it('explains why secrets aren’t available yet', async () => {
    installApi({ status: 'not-deployed', secrets: [], functionsEnabled: false })
    await renderView()
    expect(await screen.findByText('Deploy your app first')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'New secret' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/only functions can read secrets/)).toBeTruthy()
    cleanup()

    installApi({ status: 'update-rayfin', secrets: [], functionsEnabled: true, rayfinVersion: '1.35.1' })
    await renderView()
    expect(await screen.findByText('Update Rayfin to use secrets')).toBeTruthy()
    expect(screen.getByText(/this app uses Rayfin 1.35.1/)).toBeTruthy()
  })

  it('shows each deployment of a team app, read-only', async () => {
    const api = installApi({
      status: 'team',
      secrets: [],
      functionsEnabled: true,
      environments: [
        {
          kind: 'published',
          deployed: true,
          portalUrl: 'https://app.fabric.microsoft.com/groups/w/apps/1',
          secrets: [{ name: 'HELLO_WORLD', declared: false, stored: true, updatedAt: '2026-10-05T05:14:53Z' }]
        },
        { kind: 'preview', deployed: false, secrets: [] }
      ]
    })
    const onSendToChat = vi.fn()
    await renderView({ onSendToChat })

    const published = await screen.findByRole('region', { name: 'Published app' })
    expect(within(published).getByText('Not in rayfin.yml')).toBeTruthy()
    const preview = screen.getByRole('region', { name: 'Your preview' })
    expect(within(preview).getByText(/Not deployed yet/)).toBeTruthy()
    expect((screen.getByRole('button', { name: /New secret/ }) as HTMLButtonElement).disabled).toBe(true)

    const details = await openDetails('HELLO_WORLD')
    expect(within(details).getByText('Secret · Published app')).toBeTruthy()
    expect(within(details).queryByRole('button', { name: /Replace value/ })).toBeNull()
    expect(within(details).queryByRole('button', { name: /Delete/ })).toBeNull()
    fireEvent.click(within(details).getByRole('button', { name: /Open in Fabric/ }))
    expect(api.openExternal).toHaveBeenCalledWith('https://app.fabric.microsoft.com/groups/w/apps/1')
    fireEvent.click(within(details).getByRole('button', { name: /Ask Copilot to use it/ }))
    expect(onSendToChat.mock.calls[0][1]).toContain('rayfin/rayfin.yml doesn\'t list it yet')
  })

  it('offers to try again after an error', async () => {
    const api = installApi({ status: 'error', secrets: [], functionsEnabled: true, error: 'Fabric said no.', signIn: true })
    await renderView()
    expect(await screen.findByText(/Fabric said no\./)).toBeTruthy()
    expect(screen.getByText(/Refresh Fabric authentication/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }))
    await waitFor(() => expect(api.secrets.list).toHaveBeenCalledTimes(2))
  })
})
