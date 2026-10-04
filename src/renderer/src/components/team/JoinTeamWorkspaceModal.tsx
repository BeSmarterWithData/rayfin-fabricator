import { useEffect, useId, useState } from 'react'
import type { TeamJoinOptions, TeamWorkspace } from '@shared/ipc'
import { useSuppressPreview } from '../../overlay'
import { useModalFocus } from '../../modalFocus'
import { teamError } from './common'
import './team.css'

interface Props {
  onClose: () => void
  onJoined: (workspace: TeamWorkspace) => void
}

/** Join a team workspace: accept an invitation, or pick one you can access. */
export default function JoinTeamWorkspaceModal({ onClose, onJoined }: Props): JSX.Element {
  useSuppressPreview()
  const titleId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()
  const [options, setOptions] = useState<TeamJoinOptions | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [repo, setRepo] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.api.team
      .joinOptions()
      .then(setOptions)
      .catch((reason) =>
        setOptions({ ok: false, error: teamError(reason, 'Could not load invitations.'), invitations: [], discovered: [] })
      )
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  async function join(key: string, action: () => Promise<{ ok: boolean; error?: string; workspace?: TeamWorkspace }>): Promise<void> {
    setBusy(key)
    setError(null)
    try {
      const result = await action()
      if (result.ok && result.workspace) {
        onJoined(result.workspace)
        return
      }
      setError(result.error ?? 'Could not join the workspace.')
    } catch (reason) {
      setError(teamError(reason, 'Could not join the workspace.'))
    } finally {
      setBusy(null)
    }
  }

  const manualValid = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/.test(repo.trim())

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div
        className="modal team-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId}>Join a team workspace</h2>
        </div>
        <div className="modal-body team-form">
          {!options ? (
            <span className="team-muted">
              <span className="ws-spinner" /> Looking for your invitations…
            </span>
          ) : (
            <>
              {options.error && <div className="alert alert--error">{options.error}</div>}
              <section className="team-menu-section">
                <span className="team-menu-title">Invitations</span>
                {options.invitations.length === 0 ? (
                  <span className="team-muted">
                    No pending invitations. Ask the workspace&apos;s owner to invite your GitHub
                    username.
                  </span>
                ) : (
                  options.invitations.map((invite) => (
                    <div key={invite.id} className="team-app">
                      <span className="team-app-name" title={invite.description}>
                        <strong>{invite.repo}</strong>
                        {invite.inviter && <span className="team-muted"> from {invite.inviter}</span>}
                      </span>
                      <button
                        type="button"
                        className="btn btn--sm btn--primary"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void join(`i${invite.id}`, () =>
                            window.api.team.acceptInvitation(invite.id, invite.repo)
                          )
                        }
                      >
                        {busy === `i${invite.id}` ? 'Joining…' : 'Accept and join'}
                      </button>
                    </div>
                  ))
                )}
              </section>
              {options.discovered.length > 0 && (
                <section className="team-menu-section">
                  <span className="team-menu-title">Workspaces you can join</span>
                  {options.discovered.map((d) => (
                    <div key={d.repo} className="team-app">
                      <span className="team-app-name" title={d.description}>
                        <strong>{d.repo}</strong>
                      </span>
                      <button
                        type="button"
                        className="btn btn--sm"
                        disabled={Boolean(busy)}
                        onClick={() => void join(d.repo, () => window.api.team.join(d.repo))}
                      >
                        {busy === d.repo ? 'Joining…' : 'Join'}
                      </button>
                    </div>
                  ))}
                </section>
              )}
              <section className="team-menu-section">
                <span className="team-menu-title">Or enter its GitHub repository</span>
                <div className="team-row">
                  <input
                    className="field-input"
                    value={repo}
                    placeholder="owner/repository"
                    spellCheck={false}
                    onChange={(event) => setRepo(event.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={!manualValid || Boolean(busy)}
                    onClick={() => void join('manual', () => window.api.team.join(repo.trim()))}
                  >
                    {busy === 'manual' ? 'Joining…' : 'Join'}
                  </button>
                </div>
              </section>
            </>
          )}
          {error && <div className="alert alert--error">{error}</div>}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn--ghost" disabled={Boolean(busy)} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
