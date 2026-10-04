// Renders app components with sample data for screens that are hard to reach in a live
// instance (team workspaces, error dialogs, update prompts). Copied into a checkout's
// src/renderer by capture-harness.ps1; it is never part of the app build.
//
// Open /docs-harness.html?shot=<id>. Every value here is sample data.
import '@vscode/codicons/dist/codicon.css'
import './assets/main.css'
import { useEffect, type ReactNode } from 'react'
import ReactDOM from 'react-dom/client'
import type { RayfinVersionInfo, StudioProject, TeamResourceRequest, TeamSessionStatus } from '@shared/ipc'
import { OverlayProvider } from './overlay'
import { applyTheme } from './theme'
import TeamMapView from './components/team/map/TeamMapView'
import { sampleMap, sampleResources, sampleRun, sampleWorkspace } from './components/team/map/fixtures'
import TeamPublishControl from './components/team/TeamPublishControl'
import RayfinVersionControl from './components/RayfinVersionControl'
import PortConflictModal from './components/PortConflictModal'

const ok = <T,>(value: T) => (): Promise<T> => Promise.resolve(value)

/** `window.api` with sample responses; anything not listed resolves to undefined. */
function installApi(): void {
  const api = {
    openExternal: ok(undefined),
    team: {
      map: ok(sampleMap()),
      resources: (_id: string, requests: TeamResourceRequest[]) =>
        Promise.resolve({ ok: true, sources: sampleResources(requests) }),
      members: ok({
        ok: true,
        canManage: true,
        members: [
          { login: 'averychen', role: 'owner', pending: false },
          { login: 'amy', role: 'member', pending: false },
          { login: 'bo', role: 'member', pending: true, invitationId: 7 }
        ]
      }),
      health: ok({ ok: true, items: [{ id: 'pipeline', label: 'The pipeline is up to date', state: 'ok', repairable: false }] }),
      fabricAccess: ok({ ok: true, people: [] }),
      diff: ok({ ok: true, truncated: false, files: [] }),
      onProgress: () => () => {}
    }
  }
  const fallback = (target: Record<string, unknown>): unknown =>
    new Proxy(target, {
      get(obj, key: string) {
        if (key in obj) {
          const value = obj[key]
          return value && typeof value === 'object' ? fallback(value as Record<string, unknown>) : value
        }
        if (key.startsWith('on')) return () => () => {}
        return () => Promise.resolve(undefined)
      }
    })
  ;(window as unknown as { api: unknown }).api = fallback(api)
}

const project: StudioProject = {
  id: 'p1',
  name: 'Trip Logger',
  path: 'C:/team/trips/trips',
  addedAt: '',
  team: { workspaceId: sampleWorkspace.id, folder: 'trips', worktree: 'C:/team/trips' }
} as StudioProject

const teamStatus: TeamSessionStatus = {
  ok: true,
  branch: 'fabricator/averychen/trips-20261003-225801',
  unpublished: 2,
  dirty: false,
  behind: 1,
  conflicted: false,
  requireReview: true,
  view: 'preview',
  preview: { environment: 'preview/trips/averychen', state: 'success', url: 'https://example.invalid/trips' },
  production: { environment: 'production/trips', state: 'success', url: 'https://example.invalid/trips' }
} as TeamSessionStatus

const rayfinUpdate: RayfinVersionInfo = {
  version: '1.35.1',
  latest: '1.36.2',
  upgradeAvailable: true,
  packages: [
    { name: '@microsoft/rayfin-cli', kind: 'cli', installed: '1.35.1', latest: '1.36.2', upgradable: true },
    { name: '@microsoft/rayfin-core', kind: 'sdk', installed: '1.35.1', latest: '1.36.2', upgradable: true },
    { name: '@microsoft/rayfin-client', kind: 'sdk', installed: '1.35.1', latest: '1.36.2', upgradable: true }
  ]
}

const noop = (): void => {}

/** Clicks `selector` once the shot has rendered, to open a menu or popover. */
function Open({ selector, children }: { selector: string; children: ReactNode }): JSX.Element {
  useEffect(() => {
    const id = window.setTimeout(() => document.querySelector<HTMLElement>(selector)?.click(), 300)
    return () => window.clearTimeout(id)
  }, [selector])
  return <>{children}</>
}

function Shot({ id }: { id: string | null }): JSX.Element {
  switch (id) {
    case 'team-overview': {
      const map = sampleMap()
      // Started a minute and a half ago, so the run's timer reads like a live deploy.
      map.runs = [{ ...sampleRun(), startedAt: new Date(Date.now() - 95_000).toISOString() }]
      return <TeamMapView workspace={sampleWorkspace} initialMap={map} onClose={noop} onOpened={noop} />
    }
    case 'team-publish':
      return (
        <div className="appbar" style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 16px' }}>
          <Open selector=".team-split-status">
            <TeamPublishControl
              project={project}
              workspaceName={sampleWorkspace.name}
              status={teamStatus}
              syncing={false}
              onPublish={noop}
              onUpdate={noop}
              onCombine={noop}
              onDiscard={noop}
              onSetView={noop}
              onViewLogs={noop}
              onRefresh={noop}
            />
          </Open>
        </div>
      )
    case 'rayfin-version':
      return (
        <footer className="statusbar" style={{ position: 'fixed', left: 0, right: 0, bottom: 0 }}>
          <Open selector=".ver-btn">
            <RayfinVersionControl info={rayfinUpdate} onUpdate={noop} />
          </Open>
        </footer>
      )
    case 'port-conflict':
      return (
        <PortConflictModal
          conflict={{
            port: 5173,
            occupant: { pid: 18244, name: 'node.exe', commandLine: 'node node_modules/vite/bin/vite.js --port 5173' },
            canStop: true,
            suggestedPort: 5174,
            needsPush: true
          }}
          context="turn"
          busy={null}
          error={null}
          log={[]}
          onUsePort={noop}
          onStop={noop}
          onSkip={noop}
        />
      )
    default:
      return <p style={{ padding: 24 }}>Unknown shot: {String(id)}</p>
  }
}

installApi()
applyTheme('dark')
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <OverlayProvider>
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Shot id={new URLSearchParams(location.search).get('shot')} />
    </div>
  </OverlayProvider>
)
