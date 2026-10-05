import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TeamDiagnoseRequest, TeamDiagnosisEnvelope, TeamDiagnosisResult } from '@shared/ipc'
import TeamDiagnosis from './TeamDiagnosis'
import {
  IDLE_DIAGNOSIS,
  applyDiagnosisEvent,
  finishDiagnosis,
  fixInChatPrompt,
  sentDetails,
  type DiagnosisState
} from './useTeamDiagnosis'

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

/** A `window.api.team` that hands out one pending result per diagnosis. */
function mockApi(): {
  diagnose: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  results: Deferred<TeamDiagnosisResult>[]
  emit: (envelope: TeamDiagnosisEnvelope) => void
  request: (n: number) => TeamDiagnoseRequest
} {
  let listener: ((envelope: TeamDiagnosisEnvelope) => void) | null = null
  const results: Deferred<TeamDiagnosisResult>[] = []
  const diagnose = vi.fn<(request: TeamDiagnoseRequest) => Promise<TeamDiagnosisResult>>(() => {
    const next = deferred<TeamDiagnosisResult>()
    results.push(next)
    return next.promise
  })
  const cancel = vi.fn(() => Promise.resolve(true))
  ;(window as unknown as { api: unknown }).api = {
    team: {
      diagnose,
      cancel,
      onDiagnosis: vi.fn((cb: (envelope: TeamDiagnosisEnvelope) => void) => {
        listener = cb
        return () => {
          listener = null
        }
      })
    }
  }
  return {
    diagnose,
    cancel,
    results,
    emit: (envelope) => act(() => listener?.(envelope)),
    request: (n) => diagnose.mock.calls[n][0]
  }
}

describe('diagnosis state', () => {
  it('folds streamed events, and the final result wins', () => {
    let state: DiagnosisState = { ...IDLE_DIAGNOSIS, status: 'running' }
    state = applyDiagnosisEvent(state, { type: 'context', text: '## What failed' })
    state = applyDiagnosisEvent(state, { type: 'check', check: { id: 'a', label: 'A', state: 'running' } })
    state = applyDiagnosisEvent(state, { type: 'check', check: { id: 'a', label: 'A', state: 'done', detail: '- ok' } })
    state = applyDiagnosisEvent(state, { type: 'delta', text: 'Let me check.' })
    state = applyDiagnosisEvent(state, { type: 'delta', text: '', reset: true })
    state = applyDiagnosisEvent(state, { type: 'delta', text: '**Most likely cause**' })
    expect(state.checks).toEqual([{ id: 'a', label: 'A', state: 'done', detail: '- ok' }])
    expect(state.text).toBe('**Most likely cause**')
    expect(sentDetails(state)).toBe('## What failed\n\n### A\n- ok')

    const stopped = finishDiagnosis(state, { ok: false, error: 'Diagnosis stopped.', text: '', context: '', checks: [] })
    expect(stopped).toMatchObject({ status: 'error', error: 'Diagnosis stopped.', text: '', context: '## What failed' })
    expect(stopped.checks).toHaveLength(1)
  })

  it('hands the answer to the Build chat with what to do', () => {
    const prompt = fixInChatPrompt('  **Most likely cause** A missing build script.  ')
    expect(prompt).toContain('**Most likely cause** A missing build script.')
    expect(prompt).toContain('Fix the cause in this app’s code or configuration')
  })
})

describe('TeamDiagnosis', () => {
  it('runs the checks, streams the answer, and shows what was sent to Copilot', async () => {
    const api = mockApi()
    const onFixInChat = vi.fn()
    render(<TeamDiagnosis input={{ kind: 'pipeline', projectId: 'p1', runId: 7 }} onFixInChat={onFixInChat} />)
    expect(screen.getByText(/It changes nothing/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Diagnose with Copilot/ }))
    expect(api.diagnose).toHaveBeenCalledTimes(1)
    const { diagnosisId: id, ...input } = api.request(0)
    expect(input).toEqual({ kind: 'pipeline', projectId: 'p1', runId: 7 })
    expect(id).toMatch(/^team-diagnosis-/)

    api.emit({ diagnosisId: 'another-diagnosis', event: { type: 'delta', text: 'Not this one.' } })
    api.emit({ diagnosisId: id, event: { type: 'context', text: '## What failed\n- A pipeline run.' } })
    const check = { id: 'github_run_log:7', label: 'Reading pipeline run 7’s log' }
    api.emit({ diagnosisId: id, event: { type: 'check', check: { ...check, state: 'running' } } })
    expect(screen.getByText('Reading pipeline run 7’s log')).toBeTruthy()
    expect(screen.queryByText(/Copilot is looking into/)).toBeNull()

    api.emit({ diagnosisId: id, event: { type: 'check', check: { ...check, state: 'done', detail: '- npm ERR! Missing script: "build"' } } })
    expect(screen.getByText(/Copilot is looking into what the checks found/)).toBeTruthy()

    api.emit({ diagnosisId: id, event: { type: 'delta', text: '**Most likely cause**\n\nThe app has no build script.' } })
    expect(screen.getByText('The app has no build script.')).toBeTruthy()
    expect(screen.queryByText('Not this one.')).toBeNull()
    expect(screen.queryByRole('button', { name: /Fix with Copilot/ })).toBeNull()

    const answer = '**Most likely cause**\n\nThe app has no build script.'
    await act(async () =>
      api.results[0].resolve({
        ok: true,
        text: answer,
        context: '## What failed\n- A pipeline run.',
        checks: [{ ...check, state: 'done', detail: '- npm ERR! Missing script: "build"' }],
        conclusion: { summary: 'The app has no build script.', area: 'app', fixInChat: true }
      })
    )
    expect(screen.getByText(/Diagnosed by Copilot/)).toBeTruthy()
    expect(screen.getByText('1 read-only check')).toBeTruthy()
    expect(screen.getByText('Details sent to Copilot')).toBeTruthy()
    expect(screen.getByText(/npm ERR! Missing script/).textContent).toContain('## What failed')

    fireEvent.click(screen.getByRole('button', { name: /Fix with Copilot/ }))
    expect(onFixInChat).toHaveBeenCalledWith(answer)
  })

  it('stops on request, offers another try, and stops when it closes', async () => {
    const api = mockApi()
    const view = render(<TeamDiagnosis input={{ kind: 'join', repo: 'contoso/apps', error: 'Not Found' }} />)
    fireEvent.click(screen.getByRole('button', { name: /Diagnose with Copilot/ }))
    const first = api.request(0).diagnosisId

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(api.cancel).toHaveBeenCalledWith(first)
    await act(async () => api.results[0].resolve({ ok: false, error: 'Diagnosis stopped.', text: '', context: '', checks: [] }))
    expect(screen.getByRole('alert').textContent).toBe('Diagnosis stopped.')
    expect(screen.queryByText(/Diagnosed by Copilot/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(api.diagnose).toHaveBeenCalledTimes(2)
    const second = api.request(1).diagnosisId
    expect(second).not.toBe(first)
    view.unmount()
    expect(api.cancel).toHaveBeenLastCalledWith(second)
  })

  it('starts by itself in a dialog and forgets the last diagnosis when the problem changes', () => {
    const api = mockApi()
    const { rerender } = render(<TeamDiagnosis input={{ kind: 'setup', step: 'fabric' }} resetKey="a" autoStart />)
    expect(api.diagnose).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()
    rerender(<TeamDiagnosis input={{ kind: 'setup', step: 'trust' }} resetKey="b" autoStart />)
    expect(api.cancel).toHaveBeenCalledWith(api.request(0).diagnosisId)
    expect(screen.getByRole('button', { name: /Diagnose with Copilot/ })).toBeTruthy()
  })
})
