/**
 * What Fabric can say about the sources an app connects to: workspace names
 * (with their capacity) and semantic models' names, owners and links. Read with
 * the Fabric sign-in through calls that never throw, cached briefly so moving
 * between Blueprint views doesn't ask again. Failures aren't cached, so signing
 * in later fills the names in.
 */
import type { FabricWorkspace, WorkspaceModel } from '@shared/ipc'

export interface FabricInfo {
  /** By lowercase workspace id. */
  workspaces: Map<string, FabricWorkspace>
  /** By lowercase item id. */
  models: Map<string, WorkspaceModel>
}

const TTL_MS = 5 * 60_000

let workspaces: { at: number; value: Promise<Map<string, FabricWorkspace> | null> } | null = null
const models = new Map<string, { at: number; value: Promise<WorkspaceModel[] | null> }>()

const fresh = (at: number): boolean => Date.now() - at < TTL_MS

function loadWorkspaces(): Promise<Map<string, FabricWorkspace> | null> {
  if (workspaces && fresh(workspaces.at)) return workspaces.value
  const value = (async () => {
    try {
      const res = await window.api.fabric.listWorkspaces()
      if (!res.ok || !res.workspaces) return null
      return new Map(res.workspaces.map((w) => [w.id.toLowerCase(), w]))
    } catch {
      return null
    }
  })()
  workspaces = { at: Date.now(), value }
  void value.then((v) => {
    if (!v && workspaces?.value === value) workspaces = null
  })
  return value
}

function loadModels(workspaceId: string): Promise<WorkspaceModel[] | null> {
  const key = workspaceId.toLowerCase()
  const cached = models.get(key)
  if (cached && fresh(cached.at)) return cached.value
  const value = (async () => {
    try {
      const res = await window.api.fabric.listWorkspaceModels(workspaceId)
      return res.ok ? res.models : null
    } catch {
      return null
    }
  })()
  models.set(key, { at: Date.now(), value })
  void value.then((v) => {
    if (!v && models.get(key)?.value === value) models.delete(key)
  })
  return value
}

/** Look up the workspaces and semantic models an app's sources live in. */
export async function loadFabricInfo(opts: {
  workspaceIds: string[]
  /** Workspaces holding semantic models to name. */
  modelWorkspaceIds: string[]
}): Promise<FabricInfo> {
  const info: FabricInfo = { workspaces: new Map(), models: new Map() }
  if (opts.workspaceIds.length === 0 && opts.modelWorkspaceIds.length === 0) return info
  const [ws, ...lists] = await Promise.all([
    opts.workspaceIds.length ? loadWorkspaces() : Promise.resolve(null),
    ...[...new Set(opts.modelWorkspaceIds.map((w) => w.toLowerCase()))].map((w) => loadModels(w))
  ])
  for (const id of opts.workspaceIds) {
    const w = ws?.get(id.toLowerCase())
    if (w) info.workspaces.set(id.toLowerCase(), w)
  }
  for (const list of lists) {
    for (const m of list ?? []) if (m.id) info.models.set(m.id.toLowerCase(), m)
  }
  return info
}

/** Forget cached lookups (tests, and after signing in to another account). */
export function clearFabricInfo(): void {
  workspaces = null
  models.clear()
}
