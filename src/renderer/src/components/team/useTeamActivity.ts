import { useEffect, useRef, useState } from 'react'
import type { TeamMapRun } from '@shared/ipc'

/**
 * The pipeline runs of a team workspace, polled while `workspaceId` is set:
 * every few seconds while something deploys, every 20 seconds otherwise, and
 * not while the window is hidden.
 */
export function useTeamActivity(workspaceId: string | null | undefined): TeamMapRun[] {
  const [runs, setRuns] = useState<TeamMapRun[]>([])
  const runsRef = useRef(runs)
  runsRef.current = runs

  useEffect(() => {
    setRuns([])
    if (!workspaceId) return
    let stopped = false
    let timer: number | undefined
    const tick = async (): Promise<void> => {
      if (!document.hidden) {
        try {
          const activity = await window.api.team.activity(workspaceId)
          if (stopped) return
          if (activity.ok) setRuns(activity.runs)
        } catch {
          /* keep the last known runs */
        }
      }
      if (stopped) return
      const busy = runsRef.current.some((r) => r.status !== 'completed')
      timer = window.setTimeout(() => void tick(), busy ? 6_000 : 20_000)
    }
    void tick()
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [workspaceId])

  return runs
}

/** Runs still going (verification runs aside). */
export function activeDeploys(runs: TeamMapRun[]): TeamMapRun[] {
  return runs.filter((r) => r.status !== 'completed' && r.kind !== 'verify')
}
