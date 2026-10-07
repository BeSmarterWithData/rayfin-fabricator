import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode
} from 'react'
import type {
  AuthStatus,
  AzureAccountsResult,
  FabricAccountsResult,
  GithubAccountsResult,
  ProcLogEvent,
  ProcResult
} from '@shared/ipc'
import { useSuppressPreview } from '../overlay'
import { useModalFocus } from '../modalFocus'
import { getCopilotHost, signInToCopilot, signOutOfCopilot } from '../copilotAuth'
import { authErrorMessage } from '../authErrors'
import { deviceCode, tenantLabel, tenantsDiffer } from '../accounts'
import { openDocs } from '../docsLinks'
import CopilotHostInput from './CopilotHostInput'
import { CopilotLogo } from './brand-icons'
import { CheckIcon, Codicon } from './icons'
import { CopyButton } from './chat/CopyButton'
import azureSvg from '../assets/brands/azure.svg'
import fabricSvg from '../assets/brands/fabric.svg'

/** The Fabric actions the workbench owns, so they wait for deploys. */
export interface FabricAccountActions {
  /** A Fabric sign-in, sign-out, credential refresh, or deploy is running. */
  busy: boolean
  signingIn: boolean
  signingOut: boolean
  /** Refreshing credentials needs an open project's Rayfin CLI. */
  canRefresh: boolean
  /** The open project, whose Rayfin CLI runs account changes. */
  projectId?: string
  onSignIn: () => void
  onSignOut: () => void
  onRefresh: () => void
}

interface Props {
  auth: AuthStatus
  /** Re-verify every account; rejects when verification fails. */
  onAuthChanged: () => Promise<void> | void
  fabric: FabricAccountActions
  /** Open setup, e.g. to install the GitHub CLI. */
  onReviewSetup: () => void
  onClose: () => void
}

type CardState = 'ok' | 'off' | 'checking' | 'error'
type Card = 'copilot' | 'fabric' | 'az' | 'github' | 'general'

const STATE_LABEL: Record<CardState, string> = {
  ok: 'Signed in',
  off: 'Not signed in',
  checking: 'Checking…',
  error: 'Needs attention'
}

/** How long to wait for a GitHub sign-in finished in the terminal. */
const GITHUB_WAIT_MS = 5 * 60_000
const GITHUB_POLL_MS = 3000

function stateOf(status: { signedIn: boolean; checking?: boolean; error?: string }): CardState {
  if (status.checking) return 'checking'
  if (status.signedIn) return 'ok'
  return status.error ? 'error' : 'off'
}

/** Fail with the action's error. */
function expectOk(result: ProcResult, fallback: string): void {
  if (!result.ok) throw new Error(result.error || fallback)
}

/**
 * Every account Fabricator uses, in one place: who you're signed in as (and to
 * which organization), and signing in to, switching between, and signing out of
 * GitHub Copilot, Microsoft Fabric, Azure CLI and GitHub accounts without
 * leaving the app.
 */
export default function AccountsModal({
  auth,
  onAuthChanged,
  fabric,
  onReviewSetup,
  onClose
}: Props): JSX.Element {
  useSuppressPreview()
  const titleId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()
  const mountedRef = useRef(true)
  /** The running action, e.g. `copilot:in` or `azure:use:alice@contoso.com`. One at a time. */
  const [action, setAction] = useState<string | null>(null)
  const [errors, setErrors] = useState<Partial<Record<Card, string>>>({})
  const [log, setLog] = useState('')
  const logChannel = useRef<string | null>(null)
  const [host, setHost] = useState(
    () => auth.copilot.host?.replace(/^https:\/\//, '') ?? getCopilotHost()
  )
  const [fabricAccounts, setFabricAccounts] = useState<FabricAccountsResult | null>(null)
  const [azureAccounts, setAzureAccounts] = useState<AzureAccountsResult | null>(null)
  const [github, setGithub] = useState<GithubAccountsResult | null>(null)
  const [waitingForGithub, setWaitingForGithub] = useState(false)
  /** The account row asking to confirm its sign-out, e.g. `github:octo`. */
  const [confirming, setConfirming] = useState<string | null>(null)
  const pollRef = useRef<number | null>(null)

  const busy = action !== null

  const stopWaiting = useCallback((): void => {
    if (pollRef.current !== null) window.clearInterval(pollRef.current)
    pollRef.current = null
    setWaitingForGithub(false)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (pollRef.current !== null) window.clearInterval(pollRef.current)
    }
  }, [])

  useEffect(
    () =>
      window.api.onProcLog((event: ProcLogEvent) => {
        if (event.channel === logChannel.current)
          setLog((previous) => (previous + event.data).slice(-8000))
      }),
    []
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const loadFabric = useCallback(async (): Promise<void> => {
    try {
      const next = await window.api.accounts.fabric()
      if (mountedRef.current) setFabricAccounts(next)
    } catch (reason) {
      if (mountedRef.current) {
        setErrors((all) => ({
          ...all,
          fabric: authErrorMessage(reason, 'Could not list your Fabric accounts.')
        }))
      }
    }
  }, [])

  const loadAzure = useCallback(async (): Promise<void> => {
    try {
      const next = await window.api.accounts.azure()
      if (mountedRef.current) setAzureAccounts(next)
    } catch (reason) {
      if (mountedRef.current) {
        setAzureAccounts({
          azInstalled: true,
          accounts: [],
          error: authErrorMessage(reason, 'Could not list your Azure accounts. Please retry.')
        })
      }
    }
  }, [])

  const loadGithub = useCallback(async (): Promise<void> => {
    try {
      const next = await window.api.github.accounts()
      if (mountedRef.current) setGithub(next)
    } catch (reason) {
      if (mountedRef.current) {
        setGithub({
          ghInstalled: true,
          accounts: [],
          error: authErrorMessage(reason, 'Could not list your GitHub accounts. Please retry.')
        })
      }
    }
  }, [])

  useEffect(() => {
    void loadGithub()
  }, [loadGithub])

  // The lists follow the verified accounts, e.g. after a sign-out elsewhere.
  const { copilot, rayfin, az } = auth
  useEffect(() => {
    void loadFabric()
  }, [loadFabric, rayfin.signedIn, rayfin.user, rayfin.tenant])
  useEffect(() => {
    void loadAzure()
  }, [loadAzure, az.signedIn, az.user, az.tenant])

  /** Run one account action, showing its failure on `card`. Resolves whether it worked. */
  async function run(
    name: string,
    card: Card,
    work: () => Promise<void>,
    channel?: string
  ): Promise<boolean> {
    if (action) return false
    setAction(name)
    setConfirming(null)
    setErrors((all) => ({ ...all, [card]: undefined, general: undefined }))
    logChannel.current = channel ?? null
    setLog('')
    try {
      await work()
      return true
    } catch (reason) {
      if (mountedRef.current) {
        setErrors((all) => ({
          ...all,
          [card]: authErrorMessage(reason, 'That didn’t work. Please try again.')
        }))
      }
      return false
    } finally {
      logChannel.current = null
      if (mountedRef.current) setAction(null)
    }
  }

  const copilotIn = (): Promise<boolean> =>
    run(
      'copilot:in',
      'copilot',
      async () => {
        expectOk(await signInToCopilot(host), 'Copilot sign-in did not complete. Please try again.')
        await onAuthChanged()
      },
      'login:copilot'
    )
  const copilotOut = (): Promise<boolean> =>
    run('copilot:out', 'copilot', async () => {
      expectOk(await signOutOfCopilot(), 'Copilot sign-out did not complete. Please try again.')
      await onAuthChanged()
    })

  const fabricAdd = (tenant?: string): Promise<boolean> =>
    run(
      'fabric:add',
      'fabric',
      async () => {
        expectOk(
          await window.api.accounts.addFabric(tenant, fabric.projectId),
          'Fabric sign-in did not complete. Please try again.'
        )
        await Promise.all([Promise.resolve(onAuthChanged()), loadFabric()])
      },
      'login:rayfin'
    )
  const fabricUse = (id: string): Promise<boolean> =>
    run(`fabric:use:${id}`, 'fabric', async () => {
      expectOk(await window.api.accounts.useFabric(id), 'Could not switch Fabric accounts.')
      await Promise.all([Promise.resolve(onAuthChanged()), loadFabric()])
    })
  const fabricSignOut = (id: string): Promise<boolean> =>
    run(`fabric:out:${id}`, 'fabric', async () => {
      expectOk(
        await window.api.accounts.signOutFabric(id, fabric.projectId),
        'Fabric sign-out did not complete. Please try again.'
      )
      await Promise.all([Promise.resolve(onAuthChanged()), loadFabric()])
    })

  const azureAdd = (tenant?: string): Promise<boolean> =>
    run(
      'az:in',
      'az',
      async () => {
        expectOk(
          await window.api.auth.loginAz(tenant),
          'Azure sign-in did not complete. Please try again.'
        )
        await Promise.all([Promise.resolve(onAuthChanged()), loadAzure()])
      },
      'login:az'
    )
  const azureUse = (user: string, subscription: string): Promise<boolean> =>
    run(`az:use:${user}`, 'az', async () => {
      expectOk(
        await window.api.accounts.useAzure(user, subscription),
        'Could not switch Azure accounts.'
      )
      await Promise.all([Promise.resolve(onAuthChanged()), loadAzure()])
    })
  const azureSignOut = (user?: string): Promise<boolean> =>
    run(`az:out:${user ?? ''}`, 'az', async () => {
      expectOk(
        user ? await window.api.accounts.signOutAzure(user) : await window.api.auth.logoutAz(),
        'Azure sign-out did not complete. Please try again.'
      )
      await Promise.all([Promise.resolve(onAuthChanged()), loadAzure()])
    })

  const githubSwitch = (login: string): Promise<boolean> =>
    run(`github:use:${login}`, 'github', async () => {
      expectOk(await window.api.github.switchAccount(login), `Could not switch to ${login}.`)
      await loadGithub()
    })
  const githubSignOut = (login: string): Promise<boolean> =>
    run(`github:out:${login}`, 'github', async () => {
      expectOk(await window.api.github.signOutAccount(login), `Could not sign out of ${login}.`)
      await loadGithub()
    })
  const githubAdd = (): Promise<boolean> =>
    run('github:add', 'github', async () => {
      stopWaiting()
      const known = new Set(
        (github?.accounts ?? []).filter((a) => a.signedIn).map((a) => a.login.toLowerCase())
      )
      expectOk(await window.api.github.addAccount(), 'Could not start GitHub sign-in.')
      if (!mountedRef.current) return
      setWaitingForGithub(true)
      const started = Date.now()
      let inFlight = false
      pollRef.current = window.setInterval(() => {
        if (inFlight) return
        inFlight = true
        void window.api.github
          .accounts()
          .then(
            (next) => {
              if (!mountedRef.current) return
              setGithub(next)
              const arrived = next.accounts.some(
                (a) => a.signedIn && !known.has(a.login.toLowerCase())
              )
              if (arrived || Date.now() - started > GITHUB_WAIT_MS) stopWaiting()
            },
            () => {}
          )
          .finally(() => {
            inFlight = false
          })
      }, GITHUB_POLL_MS)
    })

  const recheck = (): Promise<boolean> =>
    run('recheck', 'general', async () => {
      await Promise.all([Promise.resolve(onAuthChanged()), loadFabric(), loadAzure(), loadGithub()])
    })

  const copilotState = stateOf(copilot)
  const fabricState = stateOf(rayfin)
  const azureState = stateOf(az)
  const githubState: CardState = !github
    ? 'checking'
    : !github.ghInstalled
      ? 'off'
      : github.error
        ? 'error'
        : github.accounts.some((a) => a.signedIn)
          ? 'ok'
          : 'off'
  const fabricTenant = tenantLabel(rayfin.tenant, az)
  const azureTenant = az.tenantName ?? tenantLabel(az.tenant)
  const fabricBusy = busy || fabric.busy
  const otherFabric = (fabricAccounts?.accounts ?? []).filter((a) => !a.active)
  const otherAzure = (azureAccounts?.accounts ?? []).filter((a) => !a.active)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal accounts-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId}>Accounts</h2>
          <button className="btn btn--sm btn--ghost" onClick={onClose} aria-label="Close accounts">
            ✕
          </button>
        </div>

        <div className="modal-body accounts-body">
          <p className="modal-sub accounts-lead">
            The accounts Fabricator uses on this computer. Changes apply to all your projects.
          </p>

          {errors.general && (
            <div className="alert alert--error" role="alert">
              {errors.general}
            </div>
          )}

          {tenantsDiffer(auth) && (
            <div className="alert alert--warn" role="note">
              Microsoft Fabric is signed in to <strong>{fabricTenant}</strong>, but the Azure CLI is
              signed in to <strong>{azureTenant}</strong>. Sharing and connecting data look up
              people and data through the Azure CLI, so use the same organization for both.
            </div>
          )}

          <AccountCard
            icon={<CopilotLogo />}
            title="GitHub Copilot"
            purpose="Writes and edits your app’s code."
            state={copilotState}
          >
            {copilot.signedIn ? (
              <Identity
                primary={copilot.user ?? 'Signed in'}
                secondary={copilot.host?.replace(/^https:\/\//, '')}
              />
            ) : (
              copilotState !== 'checking' && (
                <CopilotHostInput value={host} disabled={busy} onChange={setHost} />
              )
            )}
            <CardError text={errors.copilot ?? (copilot.signedIn ? undefined : copilot.error)} />
            {action === 'copilot:in' && <SignInProgress log={log} service="GitHub" />}
            <div className="acct-actions">
              {copilot.signedIn ? (
                <button
                  className="btn btn--sm"
                  disabled={busy}
                  aria-label="Sign out of GitHub Copilot"
                  onClick={() => void copilotOut()}
                >
                  {action === 'copilot:out' ? 'Signing out…' : 'Sign out'}
                </button>
              ) : (
                <button
                  className="btn btn--sm btn--primary"
                  disabled={busy || copilotState === 'checking'}
                  aria-label="Sign in to GitHub Copilot"
                  onClick={() => void copilotIn()}
                >
                  {action === 'copilot:in' ? 'Waiting for GitHub…' : 'Sign in'}
                </button>
              )}
            </div>
            <p className="acct-hint">
              To use a different GitHub account for Copilot, sign out, then sign in with that
              account.
            </p>
          </AccountCard>

          <AccountCard
            icon={<img className="brand-glyph" src={fabricSvg} alt="" />}
            title="Microsoft Fabric"
            purpose="Deploys, hosts, and shares your apps."
            state={fabricState}
          >
            {rayfin.signedIn && (
              <Identity
                primary={rayfin.user ?? 'Signed in'}
                secondary={fabricTenant}
                title={rayfin.tenant}
                badge="In use"
              />
            )}
            <CardError text={errors.fabric ?? (rayfin.signedIn ? undefined : rayfin.error)} />
            <div className="acct-actions">
              {rayfin.signedIn ? (
                <>
                  {fabric.canRefresh && (
                    <button
                      className="btn btn--sm"
                      disabled={fabricBusy}
                      onClick={fabric.onRefresh}
                    >
                      Refresh sign-in
                    </button>
                  )}
                  <button
                    className="btn btn--sm"
                    disabled={fabricBusy}
                    aria-label="Sign out of Microsoft Fabric"
                    onClick={fabric.onSignOut}
                  >
                    {fabric.signingOut ? 'Signing out…' : 'Sign out'}
                  </button>
                </>
              ) : (
                <button
                  className="btn btn--sm btn--primary"
                  disabled={fabricBusy || fabricState === 'checking'}
                  aria-label="Sign in to Microsoft Fabric"
                  onClick={fabric.onSignIn}
                >
                  {fabric.signingIn ? 'Signing in…' : 'Sign in'}
                </button>
              )}
            </div>
            {otherFabric.length > 0 && (
              <AccountList label="Other Fabric accounts">
                {otherFabric.map((account) => (
                  <AccountRow
                    key={account.id}
                    name={account.user}
                    meta={tenantLabel(account.tenant, az)}
                    title={account.tenant}
                    busy={fabricBusy}
                    using={action === `fabric:use:${account.id}`}
                    signingOut={action === `fabric:out:${account.id}`}
                    confirming={confirming === `fabric:${account.id}`}
                    onUse={() => void fabricUse(account.id)}
                    onAskSignOut={() => setConfirming(`fabric:${account.id}`)}
                    onCancelSignOut={() => setConfirming(null)}
                    onSignOut={() => void fabricSignOut(account.id)}
                  />
                ))}
              </AccountList>
            )}
            {action === 'fabric:add' && <SignInProgress log={log} service="Microsoft" />}
            <AddAccount
              label="Add a Fabric account"
              busy={fabricBusy}
              running={action === 'fabric:add'}
              onSubmit={fabricAdd}
            />
            <p className="acct-hint">
              {fabric.signingIn
                ? 'Finish signing in in the browser window that opened.'
                : 'Deploying, workspace lists, sharing, and secrets use the account in use.'}
              {fabricAccounts?.sharedTokenStore &&
              (fabricAccounts.accounts.length > 1 || otherFabric.length > 0)
                ? ' On this Mac, signing out of one Fabric account signs all of them out until you sign in again.'
                : ''}
            </p>
          </AccountCard>

          <AccountCard
            icon={<img className="brand-glyph" src={azureSvg} alt="" />}
            title="Azure CLI"
            purpose="Finds people when you share an app, connects Fabric data, and sets up team workspaces."
            state={azureState}
          >
            {az.signedIn && (
              <Identity
                primary={az.user ?? 'Signed in'}
                secondary={azureTenant}
                title={az.tenant}
                badge="In use"
              />
            )}
            <CardError
              text={errors.az ?? (az.signedIn ? undefined : az.error) ?? azureAccounts?.error}
            />
            {az.signedIn && (
              <div className="acct-actions">
                <button
                  className="btn btn--sm"
                  disabled={busy}
                  aria-label="Sign out of the Azure CLI"
                  onClick={() => void azureSignOut(az.user)}
                >
                  {action === `az:out:${az.user ?? ''}` ? 'Signing out…' : 'Sign out'}
                </button>
              </div>
            )}
            {otherAzure.length > 0 && (
              <AccountList label="Other Azure accounts">
                {otherAzure.map((account) => (
                  <AccountRow
                    key={`${account.user}|${account.tenant}`}
                    name={account.user}
                    meta={account.tenantName ?? tenantLabel(account.tenant)}
                    title={account.tenant}
                    busy={busy}
                    using={action === `az:use:${account.user}`}
                    signingOut={action === `az:out:${account.user}`}
                    confirming={confirming === `az:${account.user}|${account.tenant}`}
                    onUse={() => void azureUse(account.user, account.subscription)}
                    onAskSignOut={() => setConfirming(`az:${account.user}|${account.tenant}`)}
                    onCancelSignOut={() => setConfirming(null)}
                    onSignOut={() => void azureSignOut(account.user)}
                  />
                ))}
              </AccountList>
            )}
            {action === 'az:in' && <SignInProgress log={log} service="Microsoft" />}
            {azureAccounts && !azureAccounts.azInstalled ? (
              <div className="acct-actions">
                <button className="btn btn--sm" disabled={busy} onClick={onReviewSetup}>
                  Install from setup
                </button>
              </div>
            ) : (
              <AddAccount
                label="Add an Azure CLI account"
                firstLabel={az.signedIn || otherAzure.length > 0 ? undefined : 'Sign in'}
                busy={busy || azureState === 'checking'}
                running={action === 'az:in'}
                onSubmit={azureAdd}
              />
            )}
            <p className="acct-hint">The Azure CLI’s accounts are shared with your terminal.</p>
          </AccountCard>

          <AccountCard
            icon={<Codicon name="github" className="acct-github-ico" />}
            title="GitHub"
            purpose="Clones repositories and runs team workspaces. Optional."
            state={githubState}
          >
            {github && !github.ghInstalled ? (
              <>
                <p className="acct-hint">
                  The GitHub CLI isn’t installed. You only need it to clone repositories or use team
                  workspaces.
                </p>
                <div className="acct-actions">
                  <button className="btn btn--sm" disabled={busy} onClick={onReviewSetup}>
                    Install from setup
                  </button>
                </div>
              </>
            ) : (
              github && (
                <>
                  {github.accounts.length > 0 ? (
                    <AccountList label="GitHub accounts">
                      {github.accounts.map((account) => (
                        <AccountRow
                          key={account.login}
                          name={account.login}
                          badge={account.active ? 'Default' : undefined}
                          warning={account.signedIn ? undefined : 'Sign-in expired'}
                          useLabel="Make default"
                          canUse={!account.active && account.signedIn}
                          busy={busy}
                          using={action === `github:use:${account.login}`}
                          signingOut={action === `github:out:${account.login}`}
                          confirming={confirming === `github:${account.login}`}
                          onUse={() => void githubSwitch(account.login)}
                          onAskSignOut={() => setConfirming(`github:${account.login}`)}
                          onCancelSignOut={() => setConfirming(null)}
                          onSignOut={() => void githubSignOut(account.login)}
                        />
                      ))}
                    </AccountList>
                  ) : (
                    !github.error && (
                      <p className="acct-hint">Not signed in to any GitHub account.</p>
                    )
                  )}
                  <CardError text={errors.github ?? github.error} />
                  {waitingForGithub && (
                    <div className="acct-progress" role="status">
                      <span className="ws-spinner" aria-hidden="true" />
                      <span>
                        Finish signing in in the terminal window that opened. Your default account
                        stays the same.
                      </span>
                      <button className="btn btn--xs btn--ghost" onClick={stopWaiting}>
                        Stop waiting
                      </button>
                    </div>
                  )}
                  <div className="acct-actions">
                    <button
                      className="btn btn--sm"
                      disabled={busy}
                      onClick={() => void githubAdd()}
                    >
                      {github.accounts.length > 0 ? 'Add account' : 'Sign in'}
                    </button>
                  </div>
                  <p className="acct-hint">
                    Clone from GitHub and your terminal use the default account; team workspaces
                    remember their own. Signing out here also signs the GitHub CLI out in your
                    terminal.
                  </p>
                </>
              )
            )}
          </AccountCard>
        </div>

        <div className="modal-footer">
          <button className="btn btn--sm btn--link accounts-help" onClick={() => openDocs('accounts')}>
            Accounts help
          </button>
          <button className="btn btn--ghost" disabled={busy} onClick={() => void recheck()}>
            {action === 'recheck' ? 'Checking…' : 'Re-check'}
          </button>
          <button className="btn btn--primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

function AccountCard({
  icon,
  title,
  purpose,
  state,
  children
}: {
  icon: ReactNode
  title: string
  purpose: string
  state: CardState
  children: ReactNode
}): JSX.Element {
  return (
    <section className={`acct-card acct-card--${state}`} aria-label={title}>
      <span className="auth-ico acct-card-ico">{icon}</span>
      <div className="acct-card-main">
        <div className="acct-card-head">
          <h3 className="acct-card-title">{title}</h3>
          <span className={`acct-chip acct-chip--${state}`}>
            {state === 'ok' && <CheckIcon className="acct-chip-ico" />}
            {STATE_LABEL[state]}
          </span>
        </div>
        <p className="acct-card-purpose">{purpose}</p>
        {children}
      </div>
    </section>
  )
}

function Identity({
  primary,
  secondary,
  title,
  badge
}: {
  primary: string
  secondary?: string
  title?: string
  badge?: string
}): JSX.Element {
  return (
    <div className="acct-id" title={title}>
      <span className="acct-id-primary">{primary}</span>
      {secondary && <span className="acct-id-secondary">{secondary}</span>}
      {badge && <span className="acct-badge">{badge}</span>}
    </div>
  )
}

function CardError({ text }: { text?: string }): JSX.Element | null {
  return text ? (
    <p className="acct-error" role="alert">
      {text}
    </p>
  ) : null
}

function AccountList({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="acct-list-wrap">
      <span className="acct-list-label">{label}</span>
      <ul className="acct-list" aria-label={label}>
        {children}
      </ul>
    </div>
  )
}

/** One more signed-in account: switch to it, or sign it out (after confirming). */
function AccountRow({
  name,
  meta,
  title,
  badge,
  warning,
  useLabel = 'Use',
  canUse = true,
  busy,
  using,
  signingOut,
  confirming,
  onUse,
  onAskSignOut,
  onCancelSignOut,
  onSignOut
}: {
  name: string
  meta?: string
  title?: string
  badge?: string
  warning?: string
  useLabel?: string
  canUse?: boolean
  busy: boolean
  using: boolean
  signingOut: boolean
  confirming: boolean
  onUse: () => void
  onAskSignOut: () => void
  onCancelSignOut: () => void
  onSignOut: () => void
}): JSX.Element {
  return (
    <li className="acct-row">
      <span className="acct-row-name" title={title}>
        {name}
        {meta && <span className="acct-row-meta"> · {meta}</span>}
      </span>
      {badge && <span className="acct-badge">{badge}</span>}
      {warning && <span className="acct-badge acct-badge--warn">{warning}</span>}
      <span className="acct-row-actions">
        {confirming ? (
          <>
            <span className="acct-confirm">Sign out of {name}?</span>
            <button className="btn btn--xs btn--danger" disabled={busy} onClick={onSignOut}>
              Sign out
            </button>
            <button className="btn btn--xs btn--ghost" onClick={onCancelSignOut}>
              Cancel
            </button>
          </>
        ) : (
          <>
            {canUse && (
              <button
                className="btn btn--xs btn--ghost"
                disabled={busy}
                aria-label={`${useLabel}: ${name}`}
                onClick={onUse}
              >
                {using ? 'Switching…' : useLabel}
              </button>
            )}
            <button
              className="btn btn--xs btn--ghost"
              disabled={busy}
              aria-label={`Sign out of ${name}`}
              onClick={onAskSignOut}
            >
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </>
        )}
      </span>
    </li>
  )
}

/**
 * Sign in to one more account. The organization is optional: leave it empty for
 * the account's own, or name one it's a guest in.
 */
function AddAccount({
  label,
  firstLabel,
  busy,
  running,
  onSubmit
}: {
  /** Names the form, e.g. "Add a Fabric account". */
  label: string
  /** Shown instead of "Add account" when there's no account yet. */
  firstLabel?: string
  busy: boolean
  running: boolean
  onSubmit: (tenant?: string) => Promise<boolean>
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [tenant, setTenant] = useState('')
  const inputId = useId()

  if (!open) {
    return (
      <div className="acct-actions">
        <button className="btn btn--sm" disabled={busy} onClick={() => setOpen(true)}>
          {firstLabel ?? 'Add account'}
        </button>
      </div>
    )
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (await onSubmit(tenant.trim() || undefined)) {
      setOpen(false)
      setTenant('')
    }
  }

  return (
    <form className="acct-add" aria-label={label} onSubmit={(event) => void submit(event)}>
      <label className="field-label" htmlFor={inputId}>
        Organization (optional)
      </label>
      <input
        id={inputId}
        className="field-input"
        type="text"
        autoCapitalize="none"
        autoComplete="off"
        spellCheck={false}
        value={tenant}
        placeholder="contoso.onmicrosoft.com or a tenant ID"
        disabled={running}
        onChange={(event) => setTenant(event.target.value)}
      />
      <span className="field-hint">
        Leave it empty to use your account’s own organization, or enter one you’re a guest in.
      </span>
      <div className="acct-actions">
        <button type="submit" className="btn btn--sm btn--primary" disabled={busy}>
          {running ? 'Waiting for Microsoft…' : 'Continue'}
        </button>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          disabled={running}
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

/** A browser or device-code sign-in in progress: the code to enter, when there is one. */
function SignInProgress({ log, service }: { log: string; service: string }): JSX.Element {
  const { code, url } = deviceCode(log)
  const details = log
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-12)
    .join('\n')
  return (
    <div className="acct-progress" role="status">
      <span className="ws-spinner" aria-hidden="true" />
      {code ? (
        <div className="acct-code">
          <span>Enter this code on {service}:</span>
          <code className="acct-code-value">{code}</code>
          <CopyButton text={code} title="Copy code" />
          {url && (
            <button className="btn btn--xs" onClick={() => void window.api.openExternal(url)}>
              Open {service}
            </button>
          )}
        </div>
      ) : (
        <span>Finish signing in to {service} in your browser.</span>
      )}
      {details && (
        <details className="acct-details">
          <summary>Details</summary>
          <pre>{details}</pre>
        </details>
      )}
    </div>
  )
}
