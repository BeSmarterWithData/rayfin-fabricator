import { useEffect, useId, useMemo, useState } from 'react'
import type {
  FabricCapacity,
  TeamActionResult,
  TeamCreateRequest,
  TeamOwner,
  TeamProblem,
  TeamWorkspace
} from '@shared/ipc'
import { useSuppressPreview } from '../../overlay'
import { useModalFocus } from '../../modalFocus'
import { ProblemView, StepList, TeamPrerequisites, teamError, useStepProgress } from './common'
import TeamDiagnosis from './diagnosis/TeamDiagnosis'
import type { DiagnosisInput } from './diagnosis/useTeamDiagnosis'

/** Mirrors SETUP_STEPS in src-tauri/src/commands/team/setup.rs. */
export const SETUP_STEPS = [
  { id: 'github', label: 'Create the private GitHub repository' },
  { id: 'fabric', label: 'Create the production and preview Fabric workspaces' },
  { id: 'identity', label: 'Create the deploy identities (service principals)' },
  { id: 'trust', label: "Let the repository's pipeline sign in as those identities" },
  { id: 'access', label: 'Give the deploy identities access to Fabric' },
  { id: 'files', label: 'Add the deploy pipeline to the repository' },
  { id: 'protection', label: 'Protect the main branch' },
  { id: 'clone', label: 'Download the workspace to this computer' },
  { id: 'verify', label: 'Check that the pipeline can reach Fabric' }
] as const

type Phase = 'prereq' | 'details' | 'running' | 'failed' | 'done'

const NO_CAPACITY =
  'You don’t have access to a Fabric capacity. Ask your Fabric administrator for one, then try again.'

/** Holds a picker's place, at the picker's size, while its choices load. */
function FieldLoading({ text }: { text: string }): JSX.Element {
  return (
    <div className="field-input team-field-loading" role="status">
      <span className="ws-spinner" aria-hidden="true" />
      {text}
    </div>
  )
}

/** Why a picker has no choices, with a way to ask again. */
function FieldProblem({ text, onRetry }: { text: string; onRetry: () => void }): JSX.Element {
  return (
    <div className="team-field-problem" role="alert">
      <span className="codicon codicon-warning" aria-hidden="true" />
      <span className="team-field-problem-text">{text}</span>
      <button type="button" className="link-btn" onClick={onRetry}>
        Try again
      </button>
    </div>
  )
}

interface Props {
  /** Continue this workspace's interrupted setup instead of starting a new one. */
  resume?: TeamWorkspace
  onClose: () => void
  /** Setup finished (or progressed); the parent refreshes its list. */
  onChanged: (workspace?: TeamWorkspace) => void
  /** Give up on a failed setup: delete what it created instead. */
  onAbandon?: (workspace: TeamWorkspace) => void
}

/** Sets up a team workspace automatically, step by step. */
export default function CreateTeamWorkspaceModal({ resume, onClose, onChanged, onAbandon }: Props): JSX.Element {
  useSuppressPreview()
  const titleId = useId()
  const ownerFieldId = useId()
  const capacityFieldId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()
  const scope = useMemo(() => `team-setup-${crypto.randomUUID()}`, [])
  const [phase, setPhase] = useState<Phase>('prereq')
  const [name, setName] = useState(resume?.name ?? '')
  /** `null` while loading. */
  const [owners, setOwners] = useState<TeamOwner[] | null>(null)
  const [ownersError, setOwnersError] = useState<string | null>(null)
  const [owner, setOwner] = useState('')
  /** `null` while loading. */
  const [capacities, setCapacities] = useState<FabricCapacity[] | null>(null)
  const [capacitiesError, setCapacitiesError] = useState<string | null>(null)
  const [capacityId, setCapacityId] = useState('')
  const [clientId, setClientId] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [problem, setProblem] = useState<TeamProblem | null>(null)
  const [workspace, setWorkspace] = useState<TeamWorkspace | undefined>(resume)
  const [rows, setRows] = useStepProgress(SETUP_STEPS, scope)
  const running = phase === 'running'

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !running) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [running, onClose])

  // Owners (GitHub) and capacities (Fabric) load separately, so each picker
  // appears as soon as its own answer arrives.
  async function loadOwners(): Promise<void> {
    setOwners(null)
    setOwnersError(null)
    let list: TeamOwner[] = []
    try {
      const result = await window.api.team.owners()
      list = result.owners
      if (!result.ok || list.length === 0) {
        setOwnersError(result.error ?? 'Fabricator couldn’t find your GitHub account.')
      }
    } catch (reason) {
      setOwnersError(teamError(reason, 'Could not list your GitHub accounts.'))
    }
    setOwners(list)
    setOwner((current) => (list.some((o) => o.login === current) ? current : (list[0]?.login ?? '')))
  }

  async function loadCapacities(): Promise<void> {
    setCapacities(null)
    setCapacitiesError(null)
    let list: FabricCapacity[] = []
    try {
      const result = await window.api.team.capacities()
      list = result.capacities ?? []
      if (!result.ok) setCapacitiesError(result.error ?? 'Could not list Fabric capacities.')
    } catch (reason) {
      setCapacitiesError(teamError(reason, 'Could not list Fabric capacities.'))
    }
    setCapacities(list)
    setCapacityId((current) => (list.some((c) => c.id === current) ? current : (list[0]?.id ?? '')))
  }

  function onPrereqsReady(): void {
    if (phase !== 'prereq') return
    if (resume) {
      void run(true)
      return
    }
    setPhase('details')
    void loadOwners()
    void loadCapacities()
  }

  /** Mark steps a previous attempt already finished. */
  function seedCompleted(completed: string[]): void {
    setRows(
      SETUP_STEPS.map((s) => ({
        id: s.id,
        label: s.label,
        state: completed.includes(s.id) ? 'done' : 'pending'
      }))
    )
  }

  /** What the owner entered so far. */
  function currentRequest(): TeamCreateRequest {
    const selectedOwner = owners?.find((o) => o.login === owner)
    const capacity = capacities?.find((c) => c.id === capacityId)
    return {
      name: name.trim(),
      owner,
      ownerIsOrg: Boolean(selectedOwner?.isOrg),
      capacityId,
      capacityName: capacity?.displayName,
      existingClientId: clientId.trim() || undefined
    }
  }

  async function run(isResume: boolean): Promise<void> {
    setProblem(null)
    setPhase('running')
    const target = workspace ?? resume
    seedCompleted(isResume ? (target?.setup?.completed ?? []) : [])
    let result: TeamActionResult
    try {
      if (isResume && target) {
        result = await window.api.team.resumeSetup(target.id, scope, clientId.trim() || undefined)
      } else {
        result = await window.api.team.create(currentRequest(), scope)
      }
    } catch (reason) {
      result = { ok: false, error: teamError(reason, 'Setup stopped unexpectedly.') }
    }
    if (result.workspace) setWorkspace(result.workspace)
    onChanged(result.workspace)
    if (result.ok) {
      setPhase('done')
      return
    }
    setProblem(result.problem ?? { step: 'setup', message: result.error ?? 'Setup stopped.' })
    setPhase(result.workspace ? 'failed' : 'details')
  }

  const canCreate = Boolean(name.trim() && owner && capacityId) && phase === 'details'
  const identityProblem = problem && ['identity', 'trust'].includes(problem.step)
  // A picker that couldn't load is also worth diagnosing (locked-down tenants often stop there).
  const pickerProblem =
    owners !== null && ownersError
      ? { step: 'github', error: ownersError }
      : capacities !== null && capacitiesError
        ? { step: 'fabric', error: capacitiesError }
        : capacities !== null && capacities.length === 0
          ? { step: 'fabric', error: NO_CAPACITY }
          : null
  const diagnosis: DiagnosisInput | null =
    phase === 'failed' && problem
      ? { kind: 'setup', workspaceId: (workspace ?? resume)?.id, problem }
      : phase === 'details' && problem
        ? { kind: 'setup', problem, request: currentRequest() }
        : phase === 'details' && pickerProblem
          ? { kind: 'setup', step: pickerProblem.step, error: pickerProblem.error, request: currentRequest() }
          : null
  const diagnosisKey = `${phase}|${problem?.step ?? ''}|${problem?.message ?? ''}|${pickerProblem?.error ?? ''}`

  return (
    <div className="modal-backdrop" onClick={running ? undefined : onClose}>
      <div
        className="modal team-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId}>{resume ? `Finish setting up ${resume.name}` : 'Create a team workspace'}</h2>
        </div>
        <div className="modal-body team-form">
          {phase === 'prereq' && (
            <>
              <p className="team-muted">
                A team workspace keeps your team&apos;s apps in a private GitHub repository. Each person
                works on their own copy, and a pipeline publishes the apps to Microsoft Fabric with
                a deploy identity that Fabricator creates for you.
              </p>
              <TeamPrerequisites onReady={onPrereqsReady} />
            </>
          )}

          {phase === 'details' && (
            <>
              <label className="field">
                <span className="field-label">Workspace name</span>
                <input
                  className="field-input"
                  value={name}
                  autoFocus
                  placeholder="Sales team apps"
                  spellCheck={false}
                  onChange={(event) => setName(event.target.value)}
                />
                <span className="field-hint">
                  Used for the GitHub repository and the Fabric workspaces.
                </span>
              </label>
              <div className="field">
                <label className="field-label" htmlFor={ownerFieldId}>
                  GitHub owner
                </label>
                {owners === null ? (
                  <FieldLoading text="Finding your GitHub accounts…" />
                ) : (
                  owners.length > 0 && (
                    <select
                      id={ownerFieldId}
                      className="field-input"
                      value={owner}
                      onChange={(event) => setOwner(event.target.value)}
                    >
                      {owners.map((o) => (
                        <option key={o.login} value={o.login}>
                          {o.login}
                          {o.isOrg ? ' (organization)' : ' (you)'}
                        </option>
                      ))}
                    </select>
                  )
                )}
                {owners !== null && ownersError && (
                  <FieldProblem text={ownersError} onRetry={() => void loadOwners()} />
                )}
                <span className="field-hint">
                  The repository is private. Use an organization if your team already has one.
                </span>
              </div>
              <div className="field">
                <label className="field-label" htmlFor={capacityFieldId}>
                  Fabric capacity
                </label>
                {capacities === null ? (
                  <FieldLoading text="Finding the Fabric capacities you can use…" />
                ) : capacities.length > 0 ? (
                  <select
                    id={capacityFieldId}
                    className="field-input"
                    value={capacityId}
                    onChange={(event) => setCapacityId(event.target.value)}
                  >
                    {capacities.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.displayName}
                        {c.sku ? ` · ${c.sku}` : ''}
                        {c.region ? ` · ${c.region}` : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  !capacitiesError && <FieldProblem text={NO_CAPACITY} onRetry={() => void loadCapacities()} />
                )}
                {capacities !== null && capacitiesError && (
                  <FieldProblem text={capacitiesError} onRetry={() => void loadCapacities()} />
                )}
                <span className="field-hint">
                  Fabricator creates two Fabric workspaces on it: one for published apps and one
                  for everyone&apos;s previews.
                </span>
              </div>
              <button
                type="button"
                className="link-btn"
                onClick={() => setShowAdvanced((v) => !v)}
                aria-expanded={showAdvanced}
              >
                {showAdvanced ? 'Hide advanced options' : 'Advanced options'}
              </button>
              {showAdvanced && (
                <label className="field">
                  <span className="field-label">Existing app registration (optional)</span>
                  <input
                    className="field-input"
                    value={clientId}
                    placeholder="Application (client) ID"
                    spellCheck={false}
                    onChange={(event) => setClientId(event.target.value)}
                  />
                  <span className="field-hint">
                    Use one an administrator created if your organization doesn&apos;t let you
                    register apps. Fabricator adds the pipeline&apos;s sign-in to it.
                  </span>
                </label>
              )}
              {problem && <ProblemView problem={problem} />}
            </>
          )}

          {(phase === 'running' || phase === 'failed' || phase === 'done') && (
            <>
              <StepList rows={rows} />
              {phase === 'running' && (
                <p className="team-muted">
                  This takes a few minutes. You can keep this window open while Fabricator works.
                </p>
              )}
              {phase === 'failed' && problem && <ProblemView problem={problem} />}
              {phase === 'failed' && identityProblem && (
                <label className="field">
                  <span className="field-label">App registration from your administrator</span>
                  <input
                    className="field-input"
                    value={clientId}
                    placeholder="Application (client) ID"
                    spellCheck={false}
                    onChange={(event) => setClientId(event.target.value)}
                  />
                </label>
              )}
              {phase === 'done' && (
                <div className="team-notice">
                  <span className="team-notice-text">
                    <strong>{workspace?.name ?? name}</strong> is ready. Create an app in it, or
                    invite your teammates from its settings.
                    {workspace?.setup?.protection === 'app' &&
                      " GitHub doesn't protect the main branch on your plan, so Fabricator keeps everyone on the publish flow."}
                  </span>
                </div>
              )}
            </>
          )}
          {diagnosis && <TeamDiagnosis input={diagnosis} resetKey={diagnosisKey} />}
        </div>
        <div className="modal-footer">
          {phase === 'failed' && onAbandon && (workspace ?? resume) && (
            <button
              type="button"
              className="btn btn--ghost team-footer-start"
              onClick={() => onAbandon((workspace ?? resume)!)}
            >
              Abandon setup…
            </button>
          )}
          {phase === 'running' ? (
            <button type="button" className="btn btn--ghost" onClick={() => void window.api.team.cancel(scope)}>
              Stop waiting
            </button>
          ) : (
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              {phase === 'done' ? 'Done' : 'Cancel'}
            </button>
          )}
          {phase === 'details' && (
            <button
              type="button"
              className="btn btn--primary"
              disabled={!canCreate}
              onClick={() => void run(false)}
            >
              Create workspace
            </button>
          )}
          {phase === 'failed' && (
            <button type="button" className="btn btn--primary" onClick={() => void run(true)}>
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
