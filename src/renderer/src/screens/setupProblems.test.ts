import { describe, expect, it } from 'vitest'
import { explainSetupError, setupProblem } from './setupProblems'

describe('explaining a setup failure', () => {
  it.each([
    ['0x8A150044', 'Another installation is already running'],
    ['ERROR: Another installation is already in progress', 'Another installation is already running'],
    ['Access is denied. (0x80070005)', 'does not have permission'],
    ['Error: EACCES: permission denied, mkdir /usr/local', 'does not have permission'],
    ['getaddrinfo ENOTFOUND registry.npmjs.org', "couldn't reach the internet"],
    ['ENOSPC: no space left on device', 'not enough free space'],
    ["'winget' is not recognized as an internal or external command", 'package installer (winget)'],
    ['brew: command not found', 'Homebrew'],
    ['The operation was canceled by the user', 'was cancelled'],
    ['Your organization has enabled SAML single sign-on', 'sign in through it first'],
    ['No active Copilot subscription found', "doesn't have GitHub Copilot"],
    ["'node' is not recognized as an internal or external command", 'cannot see it yet']
  ])('turns %s into a plain cause', (raw, expected) => {
    const problem = explainSetupError(raw)
    expect(problem).not.toBeNull()
    expect(problem?.title).toContain(expected)
    expect(problem?.fix.length).toBeGreaterThan(0)
  })

  it('never invents a cause it has no evidence for', () => {
    expect(explainSetupError('Something nobody has seen before')).toBeNull()
  })

  it('treats nothing as nothing', () => {
    expect(explainSetupError('')).toBeNull()
    expect(explainSetupError('   ')).toBeNull()
    expect(explainSetupError(undefined)).toBeNull()
    expect(explainSetupError(null)).toBeNull()
  })

  it('marks a missing package manager as not worth retrying', () => {
    expect(explainSetupError("'winget' is not recognized")?.retryable).toBe(false)
    expect(explainSetupError('getaddrinfo ENOTFOUND')?.retryable).toBe(true)
  })
})

describe('falling back to the raw error', () => {
  it('shows the original text rather than a vague reassurance', () => {
    const problem = setupProblem('Something nobody has seen before')
    expect(problem?.title).toBe('Something nobody has seen before')
    expect(problem?.fix).toContain('Help')
  })

  it('prefers a recognised explanation over the raw text', () => {
    expect(setupProblem('getaddrinfo ENOTFOUND registry.npmjs.org')?.title).toContain(
      "couldn't reach the internet"
    )
  })

  it('returns nothing when there is no error', () => {
    expect(setupProblem(undefined)).toBeNull()
    expect(setupProblem('')).toBeNull()
  })
})
