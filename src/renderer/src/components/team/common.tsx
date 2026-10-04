import { useEffect, useState } from 'react'
import type { TeamEnvStatus, TeamProblem, TeamProgressEvent } from '@shared/ipc'
import './team.css'

/** One row of a progress checklist. */
export interface StepRow {
  id: string
  label: string
  state: 'pending' | 'running' | 'done' | 'error' | 'skipped'
  detail?: string
}

/** Build a checklist from step definitions, updated by `team:progress` events. */
export function useStepProgress(
  steps: ReadonlyArray<{ id: string; label: string }>,
  scope: string | null
): [StepRow[], (rows: StepRow[]) => void] {
  const [rows, setRows] = useState<StepRow[]>(() =>
    steps.map((s) => ({ id: s.id, label: s.label, state: 'pending' }))
  )
  useEffect(() => {
    if (!scope) return
    return window.api.team.onProgress((event: TeamProgressEvent) => {
      if (event.scope !== scope) return
      setRows((current) =>
        current.map((row) =>
          row.id === event.step
            ? { ...row, state: event.state, detail: event.detail ?? undefined }
            : row
        )
      )
    })
  }, [scope])
  return [rows, setRows]
}

export function StepList({ rows }: { rows: StepRow[] }): JSX.Element {
  return (
    <ol className="team-steps">
      {rows.map((row) => (
        <li key={row.id} className={`team-step team-step--${row.state}`}>
          <span className="team-step-ico" aria-hidden="true">
            {row.state === 'running' ? (
              <span className="ws-spinner" />
            ) : row.state === 'done' ? (
              '✓'
            ) : row.state === 'error' ? (
              '!'
            ) : row.state === 'skipped' ? (
              '–'
            ) : null}
          </span>
          <span className="team-step-text">
            <span className="team-step-label">{row.label}</span>
            {row.detail && <span className="team-step-detail">{row.detail}</span>}
          </span>
        </li>
      ))}
    </ol>
  )
}

/** A plain-language problem, with instructions to forward to an administrator. */
export function ProblemView({ problem }: { problem: TeamProblem }): JSX.Element {
  const [copied, setCopied] = useState(false)
  async function copy(): Promise<void> {
    if (!problem.adminNote) return
    try {
      await navigator.clipboard.writeText(problem.adminNote)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard can be unavailable; the text stays selectable */
    }
  }
  return (
    <div className="team-problem" role="alert">
      <p className="team-problem-title">{problem.message}</p>
      {problem.guidance && <p>{problem.guidance}</p>}
      {problem.adminNote && (
        <>
          <pre className="team-admin-note">{problem.adminNote}</pre>
          <div>
            <button type="button" className="btn btn--sm" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy instructions for your admin'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/** A readable message from a rejected IPC call. */
export function teamError(reason: unknown, fallback: string): string {
  if (typeof reason === 'string' && reason.trim()) return reason
  if (reason instanceof Error && reason.message) return reason.message
  return fallback
}

/**
 * GitHub and Azure prerequisites for team workspaces, with the actions that fix
 * them. Polls while a sign-in terminal is open.
 */
export function TeamPrerequisites({
  onReady
}: {
  onReady: (status: TeamEnvStatus) => void
}): JSX.Element {
  const [status, setStatus] = useState<TeamEnvStatus | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function check(): Promise<TeamEnvStatus | null> {
    try {
      const next = await window.api.team.envStatus()
      setStatus(next)
      return next
    } catch (reason) {
      setError(teamError(reason, 'Could not check your sign-ins.'))
      return null
    }
  }

  useEffect(() => {
    void check()
  }, [])

  const ready =
    Boolean(status?.ghSignedIn) && status?.ghMissingScopes.length === 0 && Boolean(status?.azSignedIn)

  useEffect(() => {
    if (ready && status) onReady(status)
  }, [ready, status])

  useEffect(() => {
    if (!waiting) return
    const id = window.setInterval(() => {
      void check().then((next) => {
        if (next?.ghSignedIn && next.ghMissingScopes.length === 0) setWaiting(false)
      })
    }, 3000)
    const stop = window.setTimeout(() => setWaiting(false), 5 * 60_000)
    return () => {
      window.clearInterval(id)
      window.clearTimeout(stop)
    }
  }, [waiting])

  async function signIn(): Promise<void> {
    setError(null)
    const result = await window.api.team.githubSignIn(Boolean(status?.ghSignedIn))
    if (!result.ok) {
      setError(result.error ?? 'Could not start GitHub sign-in.')
      return
    }
    setWaiting(true)
  }

  if (!status) {
    return (
      <div className="team-muted">
        <span className="ws-spinner" /> Checking your GitHub and Azure sign-ins…
      </div>
    )
  }

  const ghState: 'ok' | 'warn' | 'error' = !status.ghInstalled
    ? 'error'
    : !status.ghSignedIn
      ? 'error'
      : status.ghMissingScopes.length
        ? 'warn'
        : 'ok'

  return (
    <div className="team-checks">
      <div className="team-check">
        <span className={`team-check-dot team-check-dot--${ghState}`} />
        <span className="team-check-text">
          <strong>GitHub</strong>
          <div className="team-muted">
            {!status.ghInstalled
              ? 'Install the GitHub CLI (gh) from setup first.'
              : !status.ghSignedIn
                ? 'Sign in so Fabricator can create and use the team repository.'
                : status.ghMissingScopes.length
                  ? `Signed in as ${status.ghUser}. Fabricator also needs permission to manage repositories and their pipelines (${status.ghMissingScopes.join(', ')}).`
                  : `Signed in as ${status.ghUser}.`}
          </div>
        </span>
        {status.ghInstalled && ghState !== 'ok' && (
          <button type="button" className="btn btn--sm btn--primary" onClick={() => void signIn()}>
            {waiting ? 'Waiting…' : status.ghSignedIn ? 'Grant GitHub access' : 'Sign in to GitHub'}
          </button>
        )}
      </div>
      <div className="team-check">
        <span className={`team-check-dot team-check-dot--${status.azSignedIn ? 'ok' : 'error'}`} />
        <span className="team-check-text">
          <strong>Microsoft Entra ID (Azure CLI)</strong>
          <div className="team-muted">
            {status.azSignedIn
              ? `Signed in as ${status.azUser}.`
              : 'Sign in to Azure from setup so Fabricator can create the deploy identity.'}
          </div>
        </span>
      </div>
      {waiting && (
        <p className="team-muted">
          Finish signing in in the terminal window, then come back. This updates automatically.
        </p>
      )}
      {error && <div className="alert alert--error">{error}</div>}
      {!ready && !waiting && (
        <div>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => void check()}>
            Check again
          </button>
        </div>
      )}
    </div>
  )
}
