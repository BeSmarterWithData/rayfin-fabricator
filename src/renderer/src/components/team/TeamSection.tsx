import { useEffect, useState } from 'react'
import type { StudioProject, TeamInvitation, TeamReviewRequest, TeamWorkspace } from '@shared/ipc'
import CreateTeamWorkspaceModal from './CreateTeamWorkspaceModal'
import JoinTeamWorkspaceModal from './JoinTeamWorkspaceModal'
import TeamWorkspaceCard from './TeamWorkspaceCard'
import { teamError } from './common'
import './team.css'

interface Props {
  workspaces: TeamWorkspace[]
  /** A team app was opened (registered and made active). */
  onOpened: (project: StudioProject) => void
  /** Start the New project flow with this workspace as the destination. */
  onNewApp: (workspaceId: string) => void
  /** Open the workspace overview; `manage` opens it on the members and settings. */
  onOpenMap?: (workspaceId: string, manage?: boolean) => void
  /** Workspaces or members changed: refresh the projects state. */
  onChanged: () => void
}

/** Home's Team workspaces section (behind the team workspaces experiment). */
export default function TeamSection({ workspaces, onOpened, onNewApp, onOpenMap, onChanged }: Props): JSX.Element {
  const [opening, setOpening] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [invitations, setInvitations] = useState<TeamInvitation[]>([])
  const [reviews, setReviews] = useState<TeamReviewRequest[]>([])
  const [approving, setApproving] = useState<number | null>(null)
  const [creating, setCreating] = useState<TeamWorkspace | 'new' | null>(null)
  const [joining, setJoining] = useState(false)

  async function loadInbox(): Promise<void> {
    const [joinOptions, requests] = await Promise.all([
      window.api.team.joinOptions().catch(() => null),
      window.api.team.reviewRequests().catch(() => [])
    ])
    setInvitations(joinOptions?.invitations ?? [])
    setReviews(requests)
  }

  useEffect(() => {
    void loadInbox()
  }, [])

  async function open(workspaceId: string, folder: string): Promise<void> {
    setOpening(`${workspaceId}/${folder}`)
    setError(null)
    try {
      const result = await window.api.team.openProject(workspaceId, folder)
      if (result.ok && result.project) {
        onOpened(result.project)
      } else {
        setError(result.error ?? 'Could not open the app.')
      }
    } catch (reason) {
      setError(teamError(reason, 'Could not open the app.'))
    } finally {
      setOpening(null)
    }
  }

  async function approve(review: TeamReviewRequest): Promise<void> {
    setApproving(review.pr.number)
    setError(null)
    try {
      const result = await window.api.team.approve(review.workspaceId, review.pr.number)
      if (!result.ok) setError(result.error ?? 'Could not approve the changes.')
      await loadInbox()
    } finally {
      setApproving(null)
    }
  }

  return (
    <section className="home-recents team-section" aria-labelledby="team-workspaces-title">
      <div className="home-section-heading">
        <h2 id="team-workspaces-title">Team workspaces</h2>
        {workspaces.length > 0 && (
          <div className="team-section-actions">
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setJoining(true)}>
              Join
              {invitations.length > 0 && <span className="team-count">{invitations.length}</span>}
            </button>
            <button type="button" className="btn btn--sm" onClick={() => setCreating('new')}>
              <span className="codicon codicon-add" aria-hidden="true" /> New team workspace
            </button>
          </div>
        )}
      </div>

      {(invitations.length > 0 || reviews.length > 0) && (
        <div className="team-inbox" aria-label="Waiting for you">
          {invitations.length > 0 && (
            <div className="team-notice">
              <span className="team-notice-icon codicon codicon-mail" aria-hidden="true" />
              <span className="team-notice-text">
                You&apos;ve been invited to{' '}
                <strong>{invitations.length === 1 ? invitations[0].repo : `${invitations.length} team workspaces`}</strong>.
              </span>
              <button type="button" className="btn btn--sm btn--primary" onClick={() => setJoining(true)}>
                Review invitations
              </button>
            </div>
          )}
          {reviews.map((review) => (
            <div key={`${review.repo}#${review.pr.number}`} className="team-notice">
              <span className="team-notice-icon codicon codicon-git-pull-request" aria-hidden="true" />
              <span className="team-notice-text">
                <strong>{review.pr.author}</strong> wants to publish “{review.pr.title}”.
              </span>
              <button type="button" className="btn btn--sm" onClick={() => void window.api.openExternal(review.pr.url)}>
                View changes
              </button>
              <button
                type="button"
                className="btn btn--sm btn--primary"
                disabled={approving === review.pr.number}
                onClick={() => void approve(review)}
              >
                {approving === review.pr.number ? 'Approving…' : 'Approve'}
              </button>
            </div>
          ))}
        </div>
      )}

      {workspaces.length === 0 ? (
        <div className="team-empty">
          <span className="team-empty-icon codicon codicon-organization" aria-hidden="true" />
          <div className="team-empty-text">
            <p className="team-empty-title">Build apps together</p>
            <p className="team-muted">
              A team workspace keeps your team&apos;s apps on GitHub. Everyone works on their own copy with a live
              preview, and a pipeline publishes to Fabric. Fabricator sets it all up.
            </p>
            <div className="team-section-actions">
              <button type="button" className="btn btn--sm btn--primary" onClick={() => setCreating('new')}>
                Create a team workspace
              </button>
              <button type="button" className="btn btn--sm" onClick={() => setJoining(true)}>
                Join one
                {invitations.length > 0 && <span className="team-count">{invitations.length}</span>}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="team-grid">
          {workspaces.map((ws) => (
            <TeamWorkspaceCard
              key={ws.id}
              workspace={ws}
              opening={opening}
              onOpenApp={(workspaceId, folder) => void open(workspaceId, folder)}
              onOpenMap={onOpenMap}
              onNewApp={onNewApp}
              onFinishSetup={setCreating}
            />
          ))}
        </div>
      )}

      {error && <div className="alert alert--error">{error}</div>}

      {creating && (
        <CreateTeamWorkspaceModal
          resume={creating === 'new' ? undefined : creating}
          onClose={() => setCreating(null)}
          onChanged={() => onChanged()}
        />
      )}
      {joining && (
        <JoinTeamWorkspaceModal
          onClose={() => setJoining(false)}
          onJoined={() => {
            setJoining(false)
            onChanged()
            void loadInbox()
          }}
        />
      )}
    </section>
  )
}
