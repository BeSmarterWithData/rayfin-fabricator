import type { StudioProject } from '@shared/ipc'
import type { DerivedAdvisor } from '../advisor/lifecycle'
import { Codicon } from './icons'

/** The active project's content views, switched from the app bar's tabs. */
export type ProjectView = 'build' | 'code' | 'blueprint' | 'advisor'

const TABS: { id: ProjectView; label: string }[] = [
  { id: 'build', label: 'Build' },
  { id: 'code', label: 'Code' },
  { id: 'blueprint', label: 'Blueprint' },
  { id: 'advisor', label: 'Advisor' }
]

/**
 * The project's identity doubles as the way out: clicking it opens the projects
 * launcher over the still-running project. The initial echoes the launcher's
 * project cards; the path lives in the tooltip (the OS title bar shows the name).
 */
export function ProjectSwitcher({
  project,
  onClick
}: {
  project: StudioProject
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      className="project-switcher"
      onClick={onClick}
      aria-label={`${project.name} — Switch projects`}
      title={`${project.path}\nSwitch projects — open a recent project or create a new one (keeps this project running)`}
    >
      <span className="project-switcher-mark" aria-hidden="true">
        {project.name.trim()[0]?.toUpperCase() ?? '?'}
      </span>
      <span className="project-switcher-name">{project.name}</span>
      <Codicon name="unfold" className="project-switcher-caret" />
    </button>
  )
}

/** Shown on the launcher while a project stays open behind it. */
export function BackToProject({
  name,
  title,
  onClick
}: {
  name: string
  /** Tooltip; defaults to explaining the project kept running. */
  title?: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      className="app-bar-back"
      onClick={onClick}
      title={title ?? `Return to ${name} — it kept running while you browsed projects`}
    >
      <Codicon name="arrow-left" />
      <span className="app-bar-back-label">Back to {name}</span>
    </button>
  )
}

export function ProjectTabs({
  view,
  onChange,
  advisorBadge
}: {
  view: ProjectView
  onChange: (view: ProjectView) => void
  /** Open high/medium Advisor issues, counted on the Advisor tab. */
  advisorBadge: DerivedAdvisor['badge']
}): JSX.Element {
  return (
    <div className="project-tabs" role="tablist" aria-label="Project views">
      {TABS.map((tab) => {
        const badge = tab.id === 'advisor' ? advisorBadge : null
        return (
          <button
            key={tab.id}
            className={`project-tab${view === tab.id ? ' project-tab--active' : ''}`}
            role="tab"
            aria-selected={view === tab.id}
            onClick={() => onChange(tab.id)}
            title={
              tab.id !== 'advisor'
                ? undefined
                : badge
                  ? `Advisor — ${badge.count} open high or medium issue${badge.count === 1 ? '' : 's'}`
                  : 'Advisor'
            }
          >
            {tab.label}
            {badge && (
              <span
                className={`project-tab-badge project-tab-badge--${badge.severity}`}
                aria-label={`${badge.count} open ${badge.count === 1 ? 'issue' : 'issues'}`}
              >
                {badge.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
