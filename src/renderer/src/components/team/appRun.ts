import type { TeamMapRun, TeamRunStatus, TeamSessionStatus } from '@shared/ipc'

const same = (a?: string, b?: string): boolean => Boolean(a && b && a.toLowerCase() === b.toLowerCase())

/** A run that deploys this app: its preview (from its working branch) or its publish. */
function isAppRun(run: TeamMapRun, folder: string, branch?: string): boolean {
  return (
    (run.kind === 'preview' && same(run.branch, branch)) ||
    (run.kind === 'production' && run.jobs.some((j) => same(j.folder, folder) && j.conclusion !== 'skipped'))
  )
}

/**
 * The run deploying this app right now, from the workspace's activity. That is
 * polled every few seconds, so it sees a new run before the app's own status
 * (checked right after a save, often before GitHub has started the run) does.
 */
export function activityRunFor(runs: TeamMapRun[], folder: string, branch?: string): TeamMapRun | undefined {
  return runs.find((r) => r.status !== 'completed' && isAppRun(r, folder, branch))
}

/** A workspace run as this app's run, with its job's steps (none while it plans). */
export function asAppRun(run: TeamMapRun, folder: string): TeamRunStatus {
  const job = run.jobs.find((j) => same(j.folder, folder))
  return {
    id: run.id,
    kind: run.kind === 'production' ? 'production' : 'preview',
    status: run.status,
    conclusion: run.conclusion,
    url: run.url,
    sha: run.sha,
    steps: job?.steps ?? [],
    startedAt: run.startedAt
  }
}

/** The app's status, with the run deploying it taken from the activity until the status has it. */
export function withActivity(
  status: TeamSessionStatus | undefined,
  runs: TeamMapRun[],
  folder: string | undefined
): TeamSessionStatus | undefined {
  if (!status || !folder || (status.run && status.run.status !== 'completed')) return status
  const run = activityRunFor(runs, folder, status.branch)
  return run ? { ...status, run: asAppRun(run, folder) } : status
}

/** Changes whenever one of this app's runs starts or finishes: time to read its status again. */
export function appRunsKey(runs: TeamMapRun[], folder: string | undefined, branch: string | undefined): string {
  if (!folder) return ''
  return runs
    .filter((r) => isAppRun(r, folder, branch))
    .map((r) => `${r.id}:${r.status}`)
    .join(',')
}
