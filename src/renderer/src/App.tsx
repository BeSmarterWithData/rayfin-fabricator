import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppSettings, AuthProvider, AuthStatus, DoctorReport } from '@shared/ipc'
import SetupScreen from './screens/SetupScreen'
import Workbench from './screens/Workbench'
import UpdateBanner from './components/UpdateBanner'
import UpdateModal from './components/UpdateModal'
import ForcedUpdateScreen from './components/ForcedUpdateScreen'
import SplashScreen from './components/SplashScreen'
import { applyUiScale, watchTheme } from './theme'
import { useUpdates } from './update'
import { useToast } from './toast'
import { authErrorMessage } from './authErrors'
import {
  CHECKING_AUTH,
  failedAuth,
  hasCompletedSetup,
  pickAuth,
  rememberSetupComplete,
  setupAttention
} from './startup'

type Phase = 'loading' | 'setup' | 'ready'

// Keep the playful splash on screen long enough to actually be seen on a first
// launch, even when the startup checks resolve almost instantly. A computer that
// already passed setup skips it and opens straight into the app.
const SPLASH_MIN_MS = 2500
const SPLASH_MIN_MS_REDUCED = 700

const ALL_PROVIDERS: AuthProvider[] = ['copilot', 'rayfin', 'az']
/** Setup gates entry on these; the slower Fabric check only matters inside the app. */
const SETUP_PROVIDERS: AuthProvider[] = ['copilot', 'az']

function App(): JSX.Element {
  // Decided once per launch: after setup has passed here, open the app at once
  // and verify tools and accounts in the background.
  const [returning] = useState(hasCompletedSetup)
  const [setupDone, setSetupDone] = useState(returning)
  const [phase, setPhase] = useState<Phase>(returning ? 'ready' : 'loading')
  const [doctor, setDoctor] = useState<DoctorReport | null>(null)
  const [auth, setAuth] = useState<AuthStatus | null>(returning ? CHECKING_AUTH : null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const mountedRef = useRef(false)
  const refreshSeqRef = useRef(0)
  /** Per-provider generations, so an older result never overwrites a newer check. */
  const authSeqRef = useRef<Record<AuthProvider, number>>({ copilot: 0, rayfin: 0, az: 0 })
  const phaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toast = useToast()
  const { blocking } = useUpdates()

  // Don't leave the first-run splash before its minimum showtime has elapsed.
  const gateUntilRef = useRef(
    returning
      ? 0
      : Date.now() +
          (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
            ? SPLASH_MIN_MS_REDUCED
            : SPLASH_MIN_MS)
  )
  const applyPhase = useCallback((next: Phase): void => {
    if (phaseTimerRef.current !== null) clearTimeout(phaseTimerRef.current)
    const wait = gateUntilRef.current - Date.now()
    if (wait <= 0) {
      setPhase(next)
    } else {
      phaseTimerRef.current = setTimeout(() => {
        phaseTimerRef.current = null
        if (mountedRef.current) setPhase(next)
      }, wait)
    }
  }, [])

  /**
   * Verify `providers` and merge each result, unless a newer check of that
   * provider started meanwhile. Resolves with what was verified. When the check
   * itself fails, those providers read as signed out with the error (never as a
   * stale success) and it rejects with a user-facing message.
   */
  const checkAuth = useCallback(
    async (providers: AuthProvider[]): Promise<Partial<AuthStatus>> => {
      const tickets = providers.map((p) => [p, ++authSeqRef.current[p]] as const)
      const current = (): AuthProvider[] =>
        tickets.filter(([p, seq]) => authSeqRef.current[p] === seq).map(([p]) => p)
      let result: Partial<AuthStatus>
      try {
        result =
          providers.length === ALL_PROVIDERS.length
            ? await window.api.auth.status()
            : await window.api.auth.check(providers)
      } catch (reason) {
        const error = authErrorMessage(reason, 'Could not verify sign-in. Please retry.')
        const failed = mountedRef.current ? current() : []
        // Superseded by a newer check: that one reports.
        if (failed.length === 0) return {}
        setAuth((prev) => ({ ...(prev ?? CHECKING_AUTH), ...failedAuth(failed, error) }))
        throw new Error(error)
      }
      if (mountedRef.current) {
        const fresh = pickAuth(result, current())
        setAuth((prev) => ({ ...(prev ?? CHECKING_AUTH), ...fresh }))
      }
      return result
    },
    []
  )

  /**
   * Check the tools and the sign-ins setup needs, then show setup — or, with
   * `enterWhenReady` at startup, open the app when everything is in place. The
   * Fabric check runs alongside; only the app shows it.
   */
  const refresh = useCallback(
    async ({ enterWhenReady = false }: { enterWhenReady?: boolean } = {}): Promise<void> => {
      const seq = ++refreshSeqRef.current
      setRefreshing(true)
      setCheckError(null)
      setAuthError(null)
      void checkAuth(['rayfin']).catch(() => {})
      const [d, a] = await Promise.allSettled([
        Promise.resolve().then(() => window.api.doctor.check()),
        checkAuth(SETUP_PROVIDERS)
      ])
      if (!mountedRef.current || seq !== refreshSeqRef.current) return
      if (d.status === 'fulfilled') {
        setDoctor(d.value)
      } else {
        setDoctor(null)
        setCheckError(authErrorMessage(d.reason, 'Could not check the installed tools. Please retry.'))
      }
      if (a.status === 'rejected') {
        setAuthError(authErrorMessage(a.reason, 'Could not verify sign-in. Please retry.'))
      }
      const ready =
        d.status === 'fulfilled' &&
        d.value.ready &&
        a.status === 'fulfilled' &&
        Boolean(a.value.copilot?.signedIn) &&
        Boolean(a.value.az?.signedIn)
      if (enterWhenReady && ready) {
        // Nothing to set up: skip the checklist.
        rememberSetupComplete()
        setSetupDone(true)
        applyPhase('ready')
      } else {
        applyPhase('setup')
      }
      setRefreshing(false)
    },
    [applyPhase, checkAuth]
  )

  const recheck = useCallback((): Promise<void> => refresh(), [refresh])

  /** After setup has passed: open the app right away and check in the background. */
  const verifyInBackground = useCallback(async (): Promise<void> => {
    const seq = ++refreshSeqRef.current
    const tools = Promise.resolve()
      .then(() => window.api.doctor.check())
      .then(
        (report) => {
          if (mountedRef.current && seq === refreshSeqRef.current) setDoctor(report)
        },
        (reason) => {
          if (mountedRef.current && seq === refreshSeqRef.current) {
            setCheckError(authErrorMessage(reason, 'Could not check the installed tools. Please retry.'))
          }
        }
      )
    await Promise.allSettled([tools, checkAuth(SETUP_PROVIDERS), checkAuth(['rayfin'])])
  }, [checkAuth])

  /** Re-verify every account without leaving the app; rejects when verification fails. */
  const refreshAuth = useCallback(async (): Promise<void> => {
    try {
      await checkAuth(ALL_PROVIDERS)
      if (mountedRef.current) setAuthError(null)
    } catch (reason) {
      const error = authErrorMessage(reason, 'Could not verify sign-in. Please retry.')
      if (mountedRef.current) setAuthError(error)
      throw new Error(error)
    }
  }, [checkAuth])

  // Explicit transition into the workbench, triggered by the setup screen's
  // "Enter" button once every prerequisite is satisfied.
  const enter = useCallback((): void => {
    if (refreshing || !doctor?.ready || !auth?.copilot.signedIn || !auth.az.signedIn) return
    ++refreshSeqRef.current
    if (phaseTimerRef.current !== null) {
      clearTimeout(phaseTimerRef.current)
      phaseTimerRef.current = null
    }
    rememberSetupComplete()
    setSetupDone(true)
    setPhase('ready')
  }, [auth, doctor, refreshing])

  /** Leave the app for setup (e.g. a tool went missing), re-checking everything. */
  const reviewSetup = useCallback((): void => {
    if (phaseTimerRef.current !== null) {
      clearTimeout(phaseTimerRef.current)
      phaseTimerRef.current = null
    }
    gateUntilRef.current = 0
    setPhase('setup')
    void refresh()
  }, [refresh])

  /** Return from setup to the app without finishing it (setup passed here before). */
  const backToApp = useCallback((): void => {
    ++refreshSeqRef.current
    if (phaseTimerRef.current !== null) {
      clearTimeout(phaseTimerRef.current)
      phaseTimerRef.current = null
    }
    setRefreshing(false)
    setPhase('ready')
  }, [])

  useEffect(() => {
    let alive = true
    mountedRef.current = true
    void (returning ? verifyInBackground() : refresh({ enterWhenReady: true }))
    void window.api.settings.get().then(
      (next) => {
        if (alive) setSettings(next)
      },
      (reason) => {
        if (alive) {
          toast.error(authErrorMessage(reason, 'Could not load app settings. Please retry.'), {
            title: 'Settings unavailable'
          })
        }
      }
    )
    return () => {
      alive = false
      mountedRef.current = false
      ++refreshSeqRef.current
      for (const provider of ALL_PROVIDERS) ++authSeqRef.current[provider]
      if (phaseTimerRef.current !== null) clearTimeout(phaseTimerRef.current)
    }
  }, [refresh, verifyInBackground, returning, toast])

  // Apply the theme app-wide (covers splash + setup, not just the workbench)
  // and follow the OS when set to 'system'.
  useEffect(() => {
    if (!settings) return
    applyUiScale(settings.uiScale)
    return watchTheme(settings.theme)
  }, [settings])

  const updateSettings = useCallback(async (patch: Partial<AppSettings>): Promise<void> => {
    setSettings(await window.api.settings.set(patch))
  }, [])

  const attention = useMemo(() => setupAttention(doctor, auth, checkError), [doctor, auth, checkError])

  // A mandatory startup update blocks the entire app behind a forced-update screen
  // until it installs and restarts. Offline / up-to-date launches never set this.
  if (blocking) {
    return <ForcedUpdateScreen />
  }

  if (phase === 'loading') {
    return (
      <>
        <UpdateBanner />
        <UpdateModal />
        <SplashScreen />
      </>
    )
  }

  if (phase === 'ready' && auth) {
    return (
      <>
        <UpdateBanner />
        <UpdateModal />
        <Workbench
          auth={auth}
          attention={attention}
          onReviewSetup={reviewSetup}
          onAuthChanged={refreshAuth}
          settings={settings}
          onSettingsChange={updateSettings}
        />
      </>
    )
  }

  return (
    <>
      <UpdateBanner />
      <UpdateModal />
      <SetupScreen
        doctor={doctor}
        auth={auth}
        error={[checkError, authError].filter(Boolean).join(' ') || undefined}
        refreshing={refreshing}
        onRefresh={recheck}
        onEnter={enter}
        onBack={setupDone ? backToApp : undefined}
      />
    </>
  )
}

export default App
