/**
 * The Advisor's health score: a 0–100 number and an A–F grade computed from the
 * open findings, so the header can say at a glance how the app is doing.
 */
import type { AdvisorFinding } from '@shared/ipc'
import { normalizeSeverity } from '@shared/advisor/catalog'

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F'

export interface HealthScore {
  score: number
  grade: Grade
  /** No current deep review, so only the quick checks are reflected. */
  provisional: boolean
  /** An open high-severity security finding holds the grade at C or below. */
  capped: boolean
  counts: { high: number; medium: number; low: number; note: number }
}

/**
 * Points each open issue takes off. A few medium issues keep an app in the A–B
 * range, a high issue costs a letter, and only a pile-up of serious issues fails.
 */
export const PENALTY = { high: 15, medium: 5, low: 2, note: 0 } as const
/** Most one category can take off, so a single noisy area can't sink the grade alone. */
export const CATEGORY_CAP = 30
const SECURITY_CATEGORIES = new Set(['access', 'policy', 'secrets'])

export function gradeFor(score: number): Grade {
  if (score >= 90) return 'A'
  if (score >= 80) return 'B'
  if (score >= 65) return 'C'
  if (score >= 50) return 'D'
  return 'F'
}

const ORDER: Grade[] = ['A', 'B', 'C', 'D', 'F']

/** Score the open (not dismissed or resolved) findings. */
export function healthScore(open: AdvisorFinding[], deepCurrent: boolean): HealthScore {
  const counts = { high: 0, medium: 0, low: 0, note: 0 }
  const byCategory = new Map<string, number>()
  let securityHigh = false
  for (const f of open) {
    const sev = normalizeSeverity(f.severity)
    counts[sev]++
    const penalty = PENALTY[sev]
    if (penalty) byCategory.set(f.category, (byCategory.get(f.category) ?? 0) + penalty)
    if (sev === 'high' && SECURITY_CATEGORIES.has(f.category)) securityHigh = true
  }
  let total = 0
  for (const p of byCategory.values()) total += Math.min(CATEGORY_CAP, p)
  const score = Math.max(0, 100 - total)
  let grade = gradeFor(score)
  const capped = securityHigh && ORDER.indexOf(grade) < ORDER.indexOf('C')
  if (capped) grade = 'C'
  return { score, grade, provisional: !deepCurrent, capped, counts }
}
