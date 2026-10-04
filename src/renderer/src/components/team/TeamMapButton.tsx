import type { TeamMapRun } from '@shared/ipc'
import { activeDeploys } from './useTeamActivity'
import './team.css'

interface Props {
  /** The workspace pipeline's recent runs. */
  runs: TeamMapRun[]
  onClick: () => void
}

/** App bar button for the workspace overview, with a dot while anything deploys. */
export default function TeamMapButton({ runs, onClick }: Props): JSX.Element {
  const active = activeDeploys(runs).length
  const label = active
    ? `Workspace overview: ${active} deployment${active === 1 ? '' : 's'} in progress`
    : 'Workspace overview: every app, change and deployment in this team workspace'
  return (
    <button type="button" className="team-map-btn" onClick={onClick} title={label} aria-label={label}>
      <span className="codicon codicon-type-hierarchy-sub" aria-hidden="true" />
      {active > 0 && <span className="team-map-btn-dot" aria-hidden="true" />}
    </button>
  )
}
