import type { AuthProvider, AuthStatus, DoctorReport } from '@shared/ipc'

/** Set once setup has passed on this computer; later launches open straight into the app. */
const SETUP_DONE_KEY = 'fabricator.setupComplete'

export function hasCompletedSetup(): boolean {
  try {
    return localStorage.getItem(SETUP_DONE_KEY) === '1'
  } catch {
    return false
  }
}

export function rememberSetupComplete(): void {
  try {
    localStorage.setItem(SETUP_DONE_KEY, '1')
  } catch (error) {
    console.warn('Could not remember that setup is complete', error)
  }
}

/** Whether Ray was on last time, so the launch screen has him (or not) from its
 *  first frame, before settings load. */
const MASCOT_KEY = 'fabricator.mascot'

export function rememberedMascot(): boolean {
  try {
    return localStorage.getItem(MASCOT_KEY) !== '0'
  } catch {
    return true
  }
}

export function rememberMascot(on: boolean): void {
  try {
    localStorage.setItem(MASCOT_KEY, on ? '1' : '0')
  } catch {
    /* best-effort: only the next launch screen's first frame depends on it */
  }
}

/** Every account unknown while the first checks of a launch run. */
export const CHECKING_AUTH: AuthStatus = {
  copilot: { signedIn: false, checking: true },
  rayfin: { signedIn: false, checking: true },
  az: { signedIn: false, checking: true }
}

/** `result`'s entries for `providers` only. */
export function pickAuth(
  result: Partial<AuthStatus>,
  providers: AuthProvider[]
): Partial<AuthStatus> {
  const out: Partial<AuthStatus> = {}
  for (const provider of providers) {
    const value = result[provider]
    if (value) Object.assign(out, { [provider]: value })
  }
  return out
}

/** `providers` as signed out because their check failed with `error`. */
export function failedAuth(providers: AuthProvider[], error: string): Partial<AuthStatus> {
  const out: Partial<AuthStatus> = {}
  for (const provider of providers) out[provider] = { signedIn: false, error }
  return out
}

/** What a background check found that setup would have caught. */
export interface SetupAttention {
  /** Required tools that are missing, outdated, or failing their check. */
  tools: string[]
  /** Accounts setup requires that aren't signed in, by display name. */
  signIns: string[]
  /** The tool check couldn't run at all. */
  error?: string
}

/**
 * Problems to raise in the app after a background check, or null. Accounts that
 * are still being checked are never reported as signed out.
 */
export function setupAttention(
  doctor: DoctorReport | null,
  auth: AuthStatus | null,
  toolsError: string | null
): SetupAttention | null {
  const tools = (doctor?.tools ?? []).filter((t) => t.required && !t.satisfied).map((t) => t.name)
  const signIns: string[] = []
  if (auth && !auth.copilot.checking && !auth.copilot.signedIn) signIns.push('GitHub Copilot')
  if (auth && !auth.az.checking && !auth.az.signedIn) signIns.push('the Azure CLI')
  const error = toolsError ?? undefined
  return tools.length > 0 || signIns.length > 0 || error ? { tools, signIns, error } : null
}

/** "a", "a and b", "a, b, and c". */
export function listText(items: string[]): string {
  if (items.length <= 2) return items.join(' and ')
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

/** How far the first-launch checks have got, for Ray to narrate on the splash. */
export type StartupStage = 'tools' | 'accounts' | 'ready' | 'setup' | 'error'

/**
 * Where the startup checks stand: the tools, then the sign-ins setup needs, then
 * whether the app opens or setup is next. A check that couldn't run is `error`.
 */
export function startupStage(
  doctor: DoctorReport | null,
  auth: AuthStatus | null,
  failed: boolean
): StartupStage {
  if (failed) return 'error'
  if (!doctor) return 'tools'
  if (!auth || auth.copilot.checking || auth.az.checking) return 'accounts'
  return doctor.ready && auth.copilot.signedIn && auth.az.signedIn ? 'ready' : 'setup'
}
