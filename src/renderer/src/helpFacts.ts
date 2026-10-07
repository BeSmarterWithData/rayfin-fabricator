/**
 * What is true *right now*, written as short sentences the Help assistant can
 * read before it answers.
 *
 * The activity journal is a history: it says what happened, in order. On its
 * own that is a trap — a failure from twenty minutes ago reads exactly like a
 * failure from twenty seconds ago, so an assistant working only from the
 * journal will report problems the user already fixed. (It did exactly that:
 * asked "how did setup go?" on a fully green setup screen, it listed three
 * errors that had already been resolved.)
 *
 * These facts are the other half. The journal says what happened; these say
 * where things stand. Together they let the assistant say "that failed earlier
 * but it's working now" instead of raising an alarm.
 *
 * Rules for anything added here:
 *
 *   * state, not events — "Git is not installed", never "installing Git failed";
 *   * one short sentence each, in plain language the user would recognise;
 *   * only what the user can see for themselves in the UI, so the assistant
 *     never appears to know something private.
 */
import type { AuthStatus, DoctorReport, StudioProject } from '@shared/ipc'

/** Join a list the way a person would: "a, b and c". */
function sentenceList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/**
 * The state of setup: tools, accounts, and whether the user can get in.
 *
 * Used on the setup screen, where all of it is on screen in front of the user.
 */
export function setupFacts(
  doctor: DoctorReport | null,
  auth: AuthStatus | null,
  options: { online?: boolean } = {}
): string[] {
  const facts: string[] = []

  if (options.online === false) {
    // Worth saying first: it explains most of what follows.
    facts.push('This computer is currently offline.')
  }

  if (!doctor) {
    facts.push('The tool check has not finished running yet.')
  } else {
    const required = doctor.tools.filter((t) => t.required)
    const missing = required.filter((t) => !t.satisfied)
    if (missing.length === 0 && required.length > 0) {
      facts.push(
        `All ${required.length} required tools are installed and working: ${sentenceList(
          required.map((t) => (t.version ? `${t.name} ${t.version}` : t.name))
        )}.`
      )
    } else {
      for (const tool of missing) {
        facts.push(
          tool.checkError
            ? `${tool.name} is installed but its version check is failing.`
            : `${tool.name} is not installed yet.`
        )
      }
      const ready = required.filter((t) => t.satisfied)
      if (ready.length > 0) {
        facts.push(`Installed and working: ${sentenceList(ready.map((t) => t.name))}.`)
      }
    }
    // Optional tools only matter when they're present; absence isn't a problem.
    const optional = doctor.tools.filter((t) => !t.required && t.satisfied)
    if (optional.length > 0) {
      facts.push(`Also installed (optional): ${sentenceList(optional.map((t) => t.name))}.`)
    }
  }

  facts.push(...accountFacts(auth))

  const ready =
    (doctor?.ready ?? false) && (auth?.copilot.signedIn ?? false) && (auth?.az.signedIn ?? false)
  facts.push(
    ready
      ? 'Setup is complete — everything on the setup screen is green and the user can enter Fabricator.'
      : 'Setup is not finished yet; at least one step on the setup screen still needs attention.'
  )

  return facts
}

/**
 * Which accounts are connected. Separate from {@link setupFacts} because the
 * workbench knows the accounts but has no tool report of its own — and claiming
 * "the tool check has not finished" to someone who is already inside the app
 * would be worse than saying nothing.
 */
export function accountFacts(auth: AuthStatus | null): string[] {
  const facts: string[] = []

  const copilot = auth?.copilot
  if (copilot?.signedIn) {
    facts.push(
      copilot.user
        ? `Signed in to GitHub Copilot as ${copilot.user}.`
        : 'Signed in to GitHub Copilot.'
    )
  } else if (copilot?.checking) {
    facts.push('The GitHub Copilot account is still being checked.')
  } else {
    facts.push('Not signed in to GitHub Copilot.')
  }

  const az = auth?.az
  if (az?.signedIn) {
    facts.push(
      az.user ? `Signed in to Microsoft as ${az.user}.` : 'Signed in to the Microsoft account.'
    )
  } else {
    facts.push('Not signed in to the Microsoft account.')
  }

  return facts
}

/** State of the app the user is actually looking at. */
export function workbenchFacts(
  active: StudioProject | null,
  options: {
    projectCount?: number
    team?: boolean
    onHome?: boolean
    previewUrl?: string | null
    deploying?: boolean
  } = {}
): string[] {
  const facts: string[] = []

  if (!active) {
    facts.push(
      options.projectCount
        ? `No app is open right now; the user is looking at their list of ${options.projectCount} app(s).`
        : 'No app is open, and none have been created on this computer yet.'
    )
    return facts
  }

  if (options.onHome) {
    facts.push('The user is looking at their list of apps, not working inside one.')
  }

  facts.push(
    options.team
      ? `The open app is "${active.name}", which lives in a team workspace.`
      : `The open app is "${active.name}", which is a personal app on this computer.`
  )

  if (active.lastDeploy?.url) {
    const where = active.workspaceName ?? active.workspace
    facts.push(
      where
        ? `"${active.name}" has been deployed to the ${where} workspace.`
        : `"${active.name}" has been deployed.`
    )
  } else if (active.awaitingFirstDeploy) {
    facts.push(`"${active.name}" has never been deployed, so the first deploy is still pending.`)
  } else {
    facts.push(`"${active.name}" has no recorded deployment.`)
  }

  if (options.deploying) facts.push('A deploy is running right now.')
  if (options.previewUrl) facts.push(`A local preview of "${active.name}" is running.`)

  return facts
}
