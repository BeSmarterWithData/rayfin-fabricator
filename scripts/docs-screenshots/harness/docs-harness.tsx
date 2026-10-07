// Renders app components with sample data for screens that are hard to reach in a live
// instance (team workspaces, error dialogs, update prompts). Copied into a checkout's
// src/renderer by capture-harness.ps1; it is never part of the app build.
//
// Open /docs-harness.html?shot=<id>. Every value here is sample data.
import '@vscode/codicons/dist/codicon.css'
import './assets/main.css'
import { useEffect, type ReactNode } from 'react'
import ReactDOM from 'react-dom/client'
import type {
  AuthStatus,
  ChatPlanArtifact,
  DoctorReport,
  RayfinVersionInfo,
  SecretsState,
  SkillInfo,
  StudioProject,
  TeamResourceRequest,
  TeamSessionStatus,
  ToolStatus
} from '@shared/ipc'
import { OverlayProvider } from './overlay'
import { ToastProvider } from './toast'
import { applyTheme } from './theme'
import SetupScreen from './screens/SetupScreen'
import { HelpView } from './components/help/HelpView'
import TeamMapView from './components/team/map/TeamMapView'
import { sampleMap, sampleResources, sampleRun, sampleWorkspace } from './components/team/map/fixtures'
import TeamPublishControl from './components/team/TeamPublishControl'
import RayfinVersionControl from './components/RayfinVersionControl'
import PortConflictModal from './components/PortConflictModal'
import PlanCard from './components/PlanCard'
import SkillsView from './components/SkillsView'
import SecretsView from './components/SecretsView'
import './components/chat/chat.css'

const ok = <T,>(value: T) => (): Promise<T> => Promise.resolve(value)

const tool = (id: string, name: string, version: string): ToolStatus => ({
  id: id as ToolStatus['id'],
  name,
  found: true,
  satisfied: true,
  version,
  installHint: '',
  autoInstallable: true,
  required: true
})

const builtIn = (id: string, title: string, description: string, category: string, active = false): SkillInfo => ({
  id,
  title,
  description,
  icon: '',
  base: false,
  active,
  category
})
const inApp = (id: string, title: string, description: string, promotable = true): SkillInfo => ({
  id,
  title,
  description,
  icon: '🧩',
  base: false,
  active: true,
  custom: true,
  ...(promotable ? { promotable: true } : {})
})

/** The Skills tab of the sample app (a Universal App project). */
const skills: SkillInfo[] = [
  { id: 'rayfin', title: 'Rayfin essentials', description: 'Core Rayfin knowledge: data models, sign-in, deploys and the CLI.', icon: '◆', base: true, active: true },
  { id: 'rayfin-functions', title: 'Rayfin Functions', description: 'Server-side functions your app can call.', icon: 'λ', base: true, active: true },
  { id: 'rayfin-connectors', title: 'Rayfin Connectors', description: 'Use existing Fabric data: lakehouses, warehouses, SQL databases, semantic models and KQL.', icon: '⇄', base: true, active: true },
  builtIn('polished-ui', 'Polished, modern UI', 'A clean, consistent look: spacing, type, color and components that match.', 'Look & feel', true),
  builtIn('buttery-animations', 'Buttery animations', 'Quick, purposeful motion that never gets in the way.', 'Look & feel'),
  builtIn('responsive-layout', 'Responsive on every screen', 'Layouts that work on phones, tablets and wide desktops.', 'Look & feel', true),
  builtIn('easy-navigation', 'Easy navigation', 'Clear menus and page titles, and links you can share.', 'Experience'),
  builtIn('clear-copy', 'Clear, friendly wording', 'Plain-language labels, buttons, messages and empty states.', 'Experience'),
  builtIn('loading-empty-states', 'Loading & empty states', 'Every screen handles loading, empty, error and success.', 'Experience'),
  builtIn('friendly-forms', 'Friendly forms & validation', 'Forms that guide people, check input early and never lose it.', 'Experience', true),
  builtIn('search-and-filter', 'Search, sort & filter', 'Find records fast in long lists, with filtering done in the query.', 'Data'),
  builtIn('data-viz', 'Beautiful charts & dashboards', 'The right chart for each question, with the key numbers first.', 'Data'),
  builtIn('accessibility', 'Accessible to everyone', 'Works with a keyboard and screen readers, with readable contrast.', 'Quality'),
  builtIn('secure-by-default', 'Secure by default', 'Per-user data rules, signed-in pages and no secrets in the browser.', 'Quality', true),
  builtIn('performance', 'Fast & snappy', 'Quick to load and smooth to use as the app grows.', 'Quality'),
  { id: 'contoso-brand', title: 'Contoso brand', description: 'Our colors, logo use and tone of voice.', icon: '🎨', base: false, active: true, custom: true, library: true },
  inApp('capability-router', 'Capability router', 'START HERE at the beginning of essentially every build request in this universal Rayfin app.'),
  inApp('data-modeling', 'Data modeling', 'Use when the app needs to store or read data: records, a database, entities, lists, or per-user data with row-level security.', false),
  inApp('authentication', 'Enabling authentication', 'Wire the existing Fabric auth into the template’s default authenticated data workflow.'),
  inApp('graphein-visuals', 'Graphein visuals', 'Use when adding a chart, graph, plot, KPI, table, or any data visualization to this app.'),
  inApp('app-design', 'App Design', 'Use when building or modifying the app layout, UI components, or making any visual design decisions.'),
  inApp('rayfin-web-docs', 'Rayfin web documentation', 'Use before implementing or troubleshooting Rayfin-specific behavior.')
]

const secureSkill = `---
name: secure-by-default
description: "Keep the app's data and users safe by default. Use when adding sign-in, entities, permissions, sharing or admin features, or anything that reads or writes people's data. Triggers: security, secure, permissions, access control, row-level security, RLS, policy, private data, owner, sign in, authentication, authorization, secrets, API key, admin, sharing, roles"
metadata:
  author: Fabricator
  version: 1.0.0
---
# Secure by default

Assume any request can come from anyone. The browser can't enforce security; Rayfin's data rules can.

## Data access
- Give every entity explicit role rules. Start closed: grant \`@authenticated()\` access with a row-level policy, and add \`@anonymous()\` access only for data that's meant to be public.
- For per-user data, store the owner (such as \`user_id\`) and scope reads and writes with a policy like \`claims.sub.eq(item.user_id)\`.
- Hiding a button or a page isn't protection. Anything the UI prevents must also be prevented by a policy.

## Sign-in
- Pages that show or change personal data require sign-in.
`

/** Selects the skill card whose name starts with `title` once the list has loaded. */
function SelectSkill({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  useEffect(() => {
    const id = window.setTimeout(() => {
      const cards = [...document.querySelectorAll<HTMLButtonElement>('.skl-card-main')]
      cards.find((card) => card.textContent?.startsWith(title))?.click()
    }, 500)
    return () => window.clearTimeout(id)
  }, [title])
  return <>{children}</>
}

/** The sample app's function secrets (names and dates only: values are never shown). */
const secrets: SecretsState = {
  status: 'ready',
  functionsEnabled: true,
  rayfinVersion: '1.36.2',
  secrets: [
    {
      name: 'OPENAI_API_KEY',
      description: 'Summarizes expense notes',
      declared: true,
      stored: true,
      createdAt: new Date(Date.now() - 9 * 86_400_000).toISOString(),
      updatedAt: new Date(Date.now() - 2 * 86_400_000).toISOString()
    },
    {
      name: 'SLACK_WEBHOOK_URL',
      description: 'Posts approved expenses to #finance',
      declared: true,
      stored: false
    },
    {
      name: 'STRIPE_SECRET_KEY',
      description: 'Reimburses approved expenses',
      declared: true,
      stored: true,
      createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      updatedAt: new Date(Date.now() - 30 * 86_400_000).toISOString()
    }
  ]
}

/** Selects the secret row named `name` once the list has loaded. */
function SelectSecret({ name, children }: { name: string; children: ReactNode }): JSX.Element {
  useEffect(() => {
    const id = window.setTimeout(() => {
      const rows = [...document.querySelectorAll<HTMLButtonElement>('.sec-row')]
      rows.find((row) => row.textContent?.startsWith(name))?.click()
    }, 500)
    return () => window.clearTimeout(id)
  }, [name])
  return <>{children}</>
}

/** `window.api` with sample responses; anything not listed resolves to undefined. */
function installApi(): void {
  const api = {
    openExternal: ok(undefined),
    skills: {
      list: ok(skills),
      source: (_project: string, id: string) =>
        Promise.resolve({
          ok: true,
          installed: true,
          content: id === 'secure-by-default' ? secureSkill : `---\nname: ${id}\ndescription: "Sample."\n---\n# ${id}\n`
        })
    },
    secrets: {
      list: ok(secrets)
    },
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
    },
    help: {
      grounding: ok(groundedHelp),
      prepare: ok(groundedHelp),
      loadHistory: ok(helpConversation),
      saveHistory: ok(undefined),
      clearHistory: ok(undefined),
      cancel: ok(undefined),
      onEvent: () => () => {},
      ask: ok({ text: '', actions: [], citations: [], elapsedMs: 0 })
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
const noopAsync = (): Promise<void> => Promise.resolve()

const plan: ChatPlanArtifact = {
  id: 'plan-contoso-approvals',
  phase: 'review',
  summary:
    'I found the expense model, dashboard, and form flow. This plan adds manager approval without changing how Avery Chen submits expenses.',
  content: [
    '# Add manager approvals',
    '',
    '## Plan',
    '',
    '1. Add an approval status, approver, and decision comment to `Expense`.',
    '2. Update the expense list so pending, approved, and rejected items are easy to scan.',
    '3. Allow only managers to approve or reject an expense with a comment.',
    '4. Add Approve and Reject buttons to each pending expense.',
    '5. Show pending approvals on the dashboard for managers.'
  ].join('\n'),
  actions: ['interactive', 'autopilot', 'autopilot_fleet', 'exit_only'],
  recommendedAction: 'autopilot_fleet',
  todos: [
    {
      id: 'expense-status',
      title: 'Add status, approver, and decision comment fields to Expense',
      status: 'pending'
    },
    {
      id: 'manager-permissions',
      title: 'Let only managers approve or reject expenses',
      status: 'pending'
    },
    {
      id: 'approval-actions',
      title: 'Add Approve and Reject buttons with a comment',
      status: 'pending'
    },
    {
      id: 'dashboard-queue',
      title: 'Show pending approvals on the dashboard',
      status: 'pending'
    },
    {
      id: 'sample-data',
      title: 'Seed Contoso Expenses with realistic approval examples',
      status: 'pending'
    }
  ],
  dependencies: [
    { todoId: 'manager-permissions', dependsOn: 'expense-status' },
    { todoId: 'approval-actions', dependsOn: 'manager-permissions' },
    { todoId: 'dashboard-queue', dependsOn: 'approval-actions' },
    { todoId: 'sample-data', dependsOn: 'expense-status' }
  ],
  questions: []
}

/** A completed setup: every tool installed, both accounts connected. */
const setupDoctor: DoctorReport = {
  ready: true,
  tools: [
    tool('node', 'Node.js', '24.13.0'),
    tool('npm', 'npm', '11.16.0'),
    tool('git', 'Git', '2.49.0'),
    tool('az', 'Azure CLI', '2.83.0'),
    { ...tool('gh', 'GitHub CLI (gh)', '2.95.0'), required: false }
  ]
}

const setupAuth: AuthStatus = {
  copilot: { signedIn: true, user: 'averychen', host: 'github.com' },
  rayfin: { signedIn: true, user: 'avery.chen@contoso.com' },
  az: { signedIn: true, user: 'avery.chen@contoso.com' }
}

const groundedHelp = { sourceReady: true, docsReady: true, reference: 'v1.11.0', pinned: true }

/**
 * One finished Help exchange: a deploy that failed, diagnosed from the journal
 * and the docs, with the button that fixes it. `savedAt` is empty so the shot
 * doesn't show the "picking up where you left off" seam.
 */
const helpConversation = {
  savedAt: '',
  data: [
    {
      id: 'ask-1',
      question: 'why did my deploy fail?',
      attachments: [],
      answer:
        'Your Fabric sign-in expired part way through the deploy, so Fabricator could not upload the app.\n\n' +
        'The deploy stopped with "The access token has expired". Contoso Expenses is still running on the version you deployed on Tuesday — nothing was lost.\n\n' +
        '1. In the account menu, select **Refresh Fabric authentication** and finish signing in.\n' +
        '2. In the app bar, select **Redeploy**.\n\n' +
        'If it stops again at the same point, the workspace may no longer be assigned to a Fabric capacity. ' +
        'See [Deploy problems](https://spatney.github.io/rayfin-fabricator/docs/troubleshooting/deploy).',
      tools: [
        { id: 't1', name: 'read', title: 'Read the activity journal', status: 'done' },
        { id: 't2', name: 'grep', title: 'Searched the documentation for "access token has expired"', status: 'done' },
        { id: 't3', name: 'read', title: 'Read troubleshooting/deploy', status: 'done' }
      ],
      actions: [{ id: 'refresh-fabric-auth', label: 'Refresh Fabric authentication' }],
      citations: [
        {
          title: 'Deploy problems',
          url: 'https://spatney.github.io/rayfin-fabricator/docs/troubleshooting/deploy'
        }
      ],
      status: 'done',
      elapsedMs: 6300
    }
  ]
}

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
    case 'plan':
      return (
        <main
          className="chat"
          style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 32,
            background:
              'radial-gradient(circle at top, color-mix(in srgb, var(--accent) 16%, transparent), transparent 34%), var(--bg)'
          }}
        >
          <div style={{ width: 740, maxWidth: '100%' }}>
            <div className="turn turn--assistant">
              <div className="turn-main">
                <PlanCard
                  plan={plan}
                  projectName="Contoso Expenses"
                  onContentChange={noop}
                  onResolve={noop}
                  onAnswerQuestion={noop}
                  onResume={noop}
                  onExport={noopAsync}
                />
              </div>
            </div>
          </div>
        </main>
      )
    case 'skills':
      return (
        <SelectSkill title="Secure by default">
          <SkillsView project={{ ...project, id: 'p2', name: 'Contoso Expenses', team: undefined }} onChanged={noop} />
        </SelectSkill>
      )
    case 'secrets':
      return (
        <SelectSecret name="OPENAI_API_KEY">
          <SecretsView
            project={{ ...project, id: 'p2', name: 'Contoso Expenses', team: undefined }}
            onChanged={noop}
            onSendToChat={noop}
          />
        </SelectSecret>
      )
    case 'setup':
      return (
        <SetupScreen
          doctor={setupDoctor}
          auth={setupAuth}
          refreshing={false}
          onRefresh={noopAsync}
          onEnter={noop}
        />
      )
    case 'help':
      return <HelpView onClose={noop} onAction={noop} onReportIssue={noop} appVersion="1.11.0" />
    default:
      return <p style={{ padding: 24 }}>Unknown shot: {String(id)}</p>
  }
}

installApi()
applyTheme('dark')
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <OverlayProvider>
    <ToastProvider>
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Shot id={new URLSearchParams(location.search).get('shot')} />
      </div>
    </ToastProvider>
  </OverlayProvider>
)
