// Turning a failed install or sign-in into something a non-developer can act on.
//
// When an install fails, Fabricator currently shows whatever the package
// manager said — "0x8A150044", "ERROR: Another installation is already in
// progress". For the people this app is for, that is indistinguishable from
// "it's broken and I can't use this". Each pattern below names the cause in
// plain language and says what to do next; the raw text is kept so it can be
// shown on request and so nothing is lost from a bug report.

export interface SetupProblem {
  /** What went wrong, in one plain sentence. */
  title: string
  /** What to do about it. */
  fix: string
  /** True when retrying is likely to work, so the UI can offer it first. */
  retryable: boolean
}

/** Ordered: the first pattern that matches wins, so put specific ones first. */
const PATTERNS: Array<{ test: RegExp; problem: (raw: string) => SetupProblem }> = [
  {
    // Windows package manager, one install at a time.
    test: /another installation|already in progress|0x8a150044|being used by another/i,
    problem: () => ({
      title: 'Another installation is already running on this computer.',
      fix: 'Wait for it to finish — a Windows update often causes this — then try again.',
      retryable: true
    })
  },
  {
    test: /elevat|administrator|run as admin|requires admin|0x80070005|access is denied|EPERM|EACCES/i,
    problem: () => ({
      title: 'Fabricator does not have permission to install this.',
      fix: 'Close Fabricator, right-click it and choose "Run as administrator", then try again. If your computer is managed by your workplace, your IT team may need to install it for you.',
      retryable: true
    })
  },
  {
    test: /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|getaddrinfo|network|offline|could not resolve|temporary failure in name resolution|unable to connect/i,
    problem: () => ({
      title: "Fabricator couldn't reach the internet to download this.",
      fix: 'Check your connection and try again. If you are on a work network or a VPN, it may be blocking the download.',
      retryable: true
    })
  },
  {
    test: /no space|ENOSPC|disk full|not enough space/i,
    problem: () => ({
      title: 'There is not enough free space to install this.',
      fix: 'Free up some disk space and try again.',
      retryable: true
    })
  },
  {
    test: /winget.*(not recognized|not found|cannot find)|'winget'/i,
    problem: () => ({
      title: "This computer doesn't have the Windows package installer (winget).",
      fix: 'Install it from the Microsoft Store by searching for "App Installer", or use the download link to install the tool yourself.',
      retryable: false
    })
  },
  {
    test: /brew.*(not found|command not found)|'brew'/i,
    problem: () => ({
      title: "This Mac doesn't have Homebrew, which Fabricator uses to install tools.",
      fix: 'Install Homebrew from brew.sh, or use the download link to install the tool yourself.',
      retryable: false
    })
  },
  {
    test: /cancel|abort|user declined|operation was canceled/i,
    problem: () => ({
      title: 'The install was cancelled.',
      fix: 'Try again when you are ready.',
      retryable: true
    })
  },
  {
    test: /saml|single sign-?on|sso|organization has enabled/i,
    problem: () => ({
      title: 'Your organization needs you to sign in through it first.',
      fix: 'Finish the sign-in your browser opened, including any extra organization step, then try again.',
      retryable: true
    })
  },
  {
    test: /no (active )?copilot|not entitled|subscription|quota|free tier/i,
    problem: () => ({
      title: "This account doesn't have GitHub Copilot available.",
      fix: 'Sign in with an account that has Copilot, or set it up at github.com/features/copilot.',
      retryable: true
    })
  },
  {
    test: /not recognized|command not found|is not a recognized/i,
    problem: () => ({
      title: 'The tool installed, but this computer cannot see it yet.',
      fix: 'Restart Fabricator so it picks up the new tool.',
      retryable: true
    })
  }
]

/**
 * Translate a raw error into something actionable. Returns `null` when nothing
 * is recognised, so the caller shows the original text rather than a vague
 * reassurance that hides what happened.
 */
export function explainSetupError(raw: string | undefined | null): SetupProblem | null {
  const text = (raw ?? '').trim()
  if (!text) return null
  for (const { test, problem } of PATTERNS) {
    if (test.test(text)) return problem(text)
  }
  return null
}

/**
 * The problem to show for a failed step, falling back to the raw text when it
 * isn't recognised. Never invents a cause it doesn't have evidence for.
 */
export function setupProblem(raw: string | undefined | null): SetupProblem | null {
  const known = explainSetupError(raw)
  if (known) return known
  const text = (raw ?? '').trim()
  if (!text) return null
  return {
    title: text,
    fix: "If this keeps happening, ask Help — it can read what went wrong and explain it.",
    retryable: true
  }
}

/**
 * Whether installing anything can work right now. The browser's own offline
 * flag is the one signal available without making a request, and every install
 * downloads something.
 */
export function canInstall(online: boolean = navigator.onLine): boolean {
  return online
}
