/**
 * Advisor lifecycle: pure transitions over the persisted UI state (dismissals,
 * muted rules, Copilot hand-offs, verify verdicts, "new"/"resolved" tracking),
 * and the derived view the dashboard renders.
 */
import type {
  AdvisorCategoryId,
  AdvisorCondition,
  AdvisorDismissReason,
  AdvisorDismissal,
  AdvisorFinding,
  AdvisorFindingRecord,
  AdvisorResolved,
  AdvisorRuleResult,
  AdvisorRuleStatus,
  AdvisorUiState,
  AdvisorVerdict,
  AdvisorVerdictStatus
} from '@shared/ipc'
import { CATEGORIES, RULES, normalizeSeverity, ruleApplies, severityRank } from '@shared/advisor/catalog'
import type { NormalizedSnapshot } from './legacy'
import { healthScore, type HealthScore } from './score'

export function emptyState(): AdvisorUiState {
  return { version: 1, dismissed: {}, muted: {}, handoffs: {}, resolved: {} }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

/** Accept whatever was persisted, filling in anything missing. */
export function coerceState(raw: unknown): AdvisorUiState {
  const base = emptyState()
  if (!isObj(raw)) return base
  const map = <T>(v: unknown): Record<string, T> => (isObj(v) ? (v as Record<string, T>) : {})
  return {
    ...base,
    dismissed: map(raw.dismissed),
    muted: map(raw.muted),
    handoffs: map(raw.handoffs),
    resolved: map(raw.resolved),
    baseline: isObj(raw.baseline) ? (raw.baseline as unknown as AdvisorUiState['baseline']) : undefined,
    latest: isObj(raw.latest) ? (raw.latest as unknown as AdvisorUiState['latest']) : undefined,
    lastQuick: isObj(raw.lastQuick) ? map(raw.lastQuick) : undefined,
    verdicts: isObj(raw.verdicts) ? map(raw.verdicts) : undefined
  }
}

function clone(state: AdvisorUiState): AdvisorUiState {
  return {
    ...state,
    dismissed: { ...state.dismissed },
    muted: { ...state.muted },
    handoffs: { ...state.handoffs },
    resolved: { ...state.resolved },
    verdicts: state.verdicts ? { ...state.verdicts } : undefined
  }
}

export function recordOf(f: AdvisorFinding): AdvisorFindingRecord {
  return {
    title: f.title,
    ruleId: f.ruleId,
    severity: normalizeSeverity(f.severity),
    category: f.category,
    source: f.source,
    file: f.file
  }
}

function recordsOf(findings: AdvisorFinding[]): Record<string, AdvisorFindingRecord> {
  const out: Record<string, AdvisorFindingRecord> = {}
  for (const f of findings) out[f.id] = recordOf(f)
  return out
}

function resolve(
  state: AdvisorUiState,
  id: string,
  record: AdvisorFindingRecord,
  via: AdvisorResolved['via'],
  now: string
): void {
  if (state.dismissed[id] || state.muted[record.ruleId] || state.resolved[id]) return
  state.resolved[id] = { ...record, at: now, via, fixedByCopilot: Boolean(state.handoffs[id]) || undefined }
  delete state.handoffs[id]
}

/** Fold in a quick-check run: findings that disappeared are resolved. */
export function applyQuickRun(state: AdvisorUiState, quick: AdvisorFinding[], now: string): AdvisorUiState {
  const next = clone(state)
  const current = recordsOf(quick)
  for (const [id, rec] of Object.entries(state.lastQuick ?? {})) {
    if (!current[id]) resolve(next, id, rec, 'quick', now)
  }
  for (const id of Object.keys(current)) delete next.resolved[id]
  next.lastQuick = current
  if (!next.baseline) next.baseline = { at: now, kind: 'quick', entries: current }
  return next
}

/**
 * Fold in a completed deep review: deep findings from the previous review that
 * are gone are resolved, and the "new since the previous review" reference moves
 * forward.
 */
export function applyReview(
  state: AdvisorUiState,
  previous: AdvisorFinding[],
  review: AdvisorFinding[],
  quick: AdvisorFinding[],
  now: string
): AdvisorUiState {
  const next = clone(state)
  const current = recordsOf(review)
  for (const f of previous) if (!current[f.id]) resolve(next, f.id, recordOf(f), 'review', now)
  if (next.verdicts) for (const id of Object.keys(next.verdicts)) if (!current[id]) delete next.verdicts[id]
  for (const id of Object.keys(current)) {
    delete next.resolved[id]
    delete next.handoffs[id]
    delete next.verdicts?.[id]
  }
  next.baseline = next.latest ?? next.baseline ?? { at: now, kind: 'quick', entries: recordsOf(quick) }
  next.latest = { at: now, kind: 'review', entries: { ...recordsOf(quick), ...current } }
  for (const [id, r] of Object.entries(next.resolved)) if (r.at < next.baseline.at) delete next.resolved[id]
  return next
}

export function dismiss(
  state: AdvisorUiState,
  f: AdvisorFinding,
  reason: AdvisorDismissReason,
  now: string,
  note?: string
): AdvisorUiState {
  const next = clone(state)
  next.dismissed[f.id] = { reason, note: note?.trim() || undefined, at: now, title: f.title, ruleId: f.ruleId }
  delete next.handoffs[f.id]
  return next
}

export function undismiss(state: AdvisorUiState, id: string): AdvisorUiState {
  const next = clone(state)
  delete next.dismissed[id]
  return next
}

export function mute(state: AdvisorUiState, ruleId: string, now: string, note?: string): AdvisorUiState {
  const next = clone(state)
  next.muted[ruleId] = { at: now, note: note?.trim() || undefined }
  return next
}

export function unmute(state: AdvisorUiState, ruleId: string): AdvisorUiState {
  const next = clone(state)
  delete next.muted[ruleId]
  return next
}

/** Findings just handed to the Build chat for Copilot to fix. */
export function recordHandoffs(
  state: AdvisorUiState,
  findings: Pick<AdvisorFinding, 'id' | 'source'>[],
  now: string
): AdvisorUiState {
  const next = clone(state)
  for (const f of findings) next.handoffs[f.id] = { at: now, source: f.source }
  return next
}

/** The chat turn carrying pending hand-offs started. */
export function markHandoffsStarted(state: AdvisorUiState): AdvisorUiState {
  if (!Object.values(state.handoffs).some((h) => !h.started)) return state
  const next = clone(state)
  for (const [id, h] of Object.entries(next.handoffs)) if (!h.started) next.handoffs[id] = { ...h, started: true }
  return next
}

/** The chat turn carrying started hand-offs finished. */
export function markHandoffsApplied(state: AdvisorUiState, now: string): AdvisorUiState {
  if (!Object.values(state.handoffs).some((h) => h.started && !h.appliedAt)) return state
  const next = clone(state)
  for (const [id, h] of Object.entries(next.handoffs)) {
    if (h.started && !h.appliedAt) next.handoffs[id] = { ...h, appliedAt: now }
  }
  return next
}

export function applyVerdicts(
  state: AdvisorUiState,
  verdicts: AdvisorVerdict[],
  findings: AdvisorFinding[],
  now: string
): AdvisorUiState {
  const next = clone(state)
  next.verdicts = { ...(next.verdicts ?? {}) }
  const byId = new Map(findings.map((f) => [f.id, f]))
  for (const v of verdicts) {
    next.verdicts[v.findingId] = { status: v.status, note: v.note, at: now }
    const f = byId.get(v.findingId)
    if (v.status === 'fixed' && f) resolve(next, f.id, recordOf(f), 'verify', now)
  }
  return next
}

export function clearResolved(state: AdvisorUiState): AdvisorUiState {
  return { ...clone(state), resolved: {} }
}

/* ------------------------------ derived view ------------------------------ */

export type FindingStatus =
  | 'open'
  /** Handed to Copilot; the chat turn hasn't finished. */
  | 'fixing'
  /** The turn finished; waiting for quick checks to re-run. */
  | 'checking'
  /** A deep-review finding's fix was applied; Verify can confirm it. */
  | 'applied'
  /** Still detected after a fix. */
  | 'still'
  | 'dismissed'
  | 'muted'

export interface FindingItem {
  finding: AdvisorFinding
  status: FindingStatus
  isNew: boolean
  dismissal?: AdvisorDismissal
  verdict?: { status: AdvisorVerdictStatus; note?: string; at: string }
}

/** Where a finding handed to Copilot stands now, as the chat's fix cards show it. */
export type FixOutcome =
  | 'fixing'
  | 'checking'
  | 'applied'
  /** Still detected (or detected again) after the fix. */
  | 'still'
  /** No longer detected. */
  | 'fixed'
  | 'dismissed'
  | 'muted'

/** The outcome of every finding the Advisor knows about, by finding id. */
export function fixOutcomes(derived: Pick<DerivedAdvisor, 'items' | 'resolved'>): Map<string, FixOutcome> {
  const out = new Map<string, FixOutcome>()
  for (const r of derived.resolved) out.set(r.id, 'fixed')
  // A handed-off finding loses its hand-off only once it's resolved, dismissed,
  // or found again by a later review — so "open" here means it's still there.
  for (const { finding, status } of derived.items) out.set(finding.id, status === 'open' ? 'still' : status)
  return out
}

export type RuleState = AdvisorRuleStatus | 'pending' | 'running'

export interface RuleView {
  status: RuleState
  note?: string
}

/** Where one rule stands for this app, as the checks strip and area lists show it. */
export type CheckOutcome =
  | 'high'
  | 'medium'
  | 'low'
  | 'note'
  /** Its finding was dismissed, or the rule is muted. */
  | 'dismissed'
  | 'passed'
  /** Evaluated, but couldn't be checked (offline, or the review skipped it). */
  | 'skipped'
  /** A deep-review rule no current review has checked yet. */
  | 'waiting'
  | 'na'

export interface CheckView {
  ruleId: string
  category: AdvisorCategoryId
  outcome: CheckOutcome
  /** The review's note: why it passed, or why it couldn't be checked. */
  note?: string
  /** The open finding this rule reported. */
  findingId?: string
  /** A deep review is checking it right now. */
  running?: boolean
}

export interface CheckTally {
  passed: number
  /** Rules with an open high, medium, or low finding. */
  issues: number
  notes: number
  dismissed: number
  skipped: number
  waiting: number
  /** Rules that apply to this app. */
  applicable: number
}

const OUTCOME_ORDER: Record<CheckOutcome, number> = {
  high: 0,
  medium: 1,
  low: 2,
  note: 3,
  waiting: 4,
  skipped: 5,
  dismissed: 6,
  passed: 7,
  na: 8
}

/** Checklist order: problems first, then open questions, then settled rules. */
export function outcomeRank(outcome: CheckOutcome): number {
  return OUTCOME_ORDER[outcome]
}

export function isIssueOutcome(outcome: CheckOutcome): outcome is 'high' | 'medium' | 'low' {
  return outcome === 'high' || outcome === 'medium' || outcome === 'low'
}

export interface CategorySummary {
  id: AdvisorCategoryId
  title: string
  open: { high: number; medium: number; low: number; note: number }
  /** Open issues, excluding notes. */
  issues: number
  passed: number
  /** Rules that apply to this project. */
  applicable: number
  /** Deep-review rules not evaluated yet. */
  pending: number
  /** Rules that couldn't be checked this time. */
  skipped: number
  state: 'fail' | 'warn' | 'pass' | 'na' | 'pending' | 'running'
}

export interface DerivedAdvisor {
  /** Every current finding (open, dismissed, muted), most severe first. */
  items: FindingItem[]
  /** Findings that still need attention (not dismissed or muted). */
  open: FindingItem[]
  hidden: FindingItem[]
  resolved: (AdvisorResolved & { id: string })[]
  rules: Map<string, RuleView>
  /** Every catalog rule's outcome, in catalog order. */
  checks: CheckView[]
  tally: CheckTally
  categories: CategorySummary[]
  score: HealthScore
  /** Open high/medium issues for the tab badge (null when there are none). */
  badge: { count: number; severity: 'high' | 'medium' } | null
  newCount: number
}

export interface DeriveInput {
  quick: {
    findings: AdvisorFinding[]
    results: AdvisorRuleResult[]
    ranAt?: string
    /** What the project uses; deep-review rules for anything else don't apply. */
    conditions?: readonly AdvisorCondition[]
  } | null
  deep: NormalizedSnapshot | null
  /** A deep review in progress (its findings replace the saved review's). */
  live: { findings: AdvisorFinding[]; results: AdvisorRuleResult[] } | null
  state: AdvisorUiState
  deepCurrent: boolean
}

const CATEGORY_ORDER = new Map(CATEGORIES.map((c, i) => [c.id as string, i]))

function statusOf(f: AdvisorFinding, input: DeriveInput): FindingStatus {
  const { state, quick } = input
  if (state.muted[f.ruleId]) return 'muted'
  if (state.dismissed[f.id]) return 'dismissed'
  const verdict = state.verdicts?.[f.id]
  const handoff = state.handoffs[f.id]
  if (handoff) {
    if (!handoff.appliedAt) return 'fixing'
    if (f.source === 'quick') {
      return quick?.ranAt && quick.ranAt > handoff.appliedAt ? 'still' : 'checking'
    }
    return verdict?.status === 'present' && verdict.at > handoff.appliedAt ? 'still' : 'applied'
  }
  if (verdict?.status === 'present') return 'still'
  return 'open'
}

export function deriveAdvisor(input: DeriveInput): DerivedAdvisor {
  const { state, quick, deep, live } = input
  const ai = live ? live.findings : deep?.report.ok ? deep.report.findings : []
  const seen = new Set<string>()
  const all: AdvisorFinding[] = []
  for (const f of [...(quick?.findings ?? []), ...ai]) {
    if (seen.has(f.id)) continue
    seen.add(f.id)
    if (state.verdicts?.[f.id]?.status === 'fixed') continue
    all.push(f)
  }

  const baseline = state.baseline
  const items: FindingItem[] = all.map((finding) => ({
    finding,
    status: statusOf(finding, input),
    isNew: Boolean(
      baseline && !baseline.entries[finding.id] && (finding.source === 'quick' || baseline.kind === 'review')
    ),
    dismissal: state.dismissed[finding.id],
    verdict: state.verdicts?.[finding.id]
  }))
  items.sort(
    (a, b) =>
      severityRank(a.finding.severity) - severityRank(b.finding.severity) ||
      (CATEGORY_ORDER.get(a.finding.category) ?? 99) - (CATEGORY_ORDER.get(b.finding.category) ?? 99) ||
      a.finding.title.localeCompare(b.finding.title)
  )
  const open = items.filter((i) => i.status !== 'dismissed' && i.status !== 'muted')
  const hidden = items.filter((i) => i.status === 'dismissed' || i.status === 'muted')

  const rules = new Map<string, RuleView>()
  for (const r of quick?.results ?? []) rules.set(r.ruleId, { status: r.status, note: r.note })
  const aiResults = live ? live.results : deep && !deep.legacy && deep.report.ok ? (deep.report.rules ?? []) : []
  for (const r of aiResults) rules.set(r.ruleId, { status: r.status, note: r.note })
  const conditions = quick?.conditions ? new Set(quick.conditions) : null
  for (const rule of RULES) {
    if (rule.engine !== 'ai' || rules.has(rule.id)) continue
    if (conditions && !ruleApplies(rule, conditions)) {
      rules.set(rule.id, { status: 'na', note: 'Doesn’t apply to this app.' })
    } else {
      rules.set(rule.id, { status: live ? 'running' : 'pending' })
    }
  }
  for (const item of open) {
    const view = rules.get(item.finding.ruleId)
    if (view && view.status !== 'fail') rules.set(item.finding.ruleId, { status: 'fail' })
  }

  const categories: CategorySummary[] = CATEGORIES.map((c) => {
    const inCategory = RULES.filter((r) => r.category === c.id)
    let passed = 0
    let applicable = 0
    let pending = 0
    let running = 0
    let skipped = 0
    for (const rule of inCategory) {
      const status = rules.get(rule.id)?.status
      if (status === 'na') continue
      applicable++
      if (status === 'pass') passed++
      if (status === 'pending') pending++
      if (status === 'running') running++
      if (status === 'skipped') skipped++
    }
    const counts = { high: 0, medium: 0, low: 0, note: 0 }
    for (const item of open) {
      if (item.finding.category === c.id) counts[normalizeSeverity(item.finding.severity)]++
    }
    const issues = counts.high + counts.medium + counts.low
    let stateName: CategorySummary['state']
    if (counts.high + counts.medium > 0) stateName = 'fail'
    else if (counts.low > 0) stateName = 'warn'
    else if (running > 0) stateName = 'running'
    else if (applicable === 0) stateName = 'na'
    else if (passed === 0 && pending > 0) stateName = 'pending'
    else stateName = 'pass'
    return {
      id: c.id,
      title: c.title,
      open: counts,
      issues,
      passed,
      applicable,
      pending: pending + running,
      skipped,
      state: stateName
    }
  })

  const openByRule = new Map<string, FindingItem>()
  for (const item of open) {
    const cur = openByRule.get(item.finding.ruleId)
    if (!cur || severityRank(item.finding.severity) < severityRank(cur.finding.severity)) {
      openByRule.set(item.finding.ruleId, item)
    }
  }
  const hiddenRules = new Set(hidden.map((i) => i.finding.ruleId))
  const checks = RULES.map((rule): CheckView => {
    const view = rules.get(rule.id)
    const base = { ruleId: rule.id, category: rule.category, note: view?.note }
    const item = openByRule.get(rule.id)
    if (item) return { ...base, outcome: normalizeSeverity(item.finding.severity), findingId: item.finding.id }
    switch (view?.status) {
      case 'na':
        return { ...base, outcome: 'na' }
      case 'fail':
        // No open finding left: it was dismissed or muted, or fixed and verified.
        return { ...base, outcome: hiddenRules.has(rule.id) || state.muted[rule.id] ? 'dismissed' : 'passed' }
      case 'pass':
        return { ...base, outcome: 'passed' }
      case 'skipped':
        return { ...base, outcome: 'skipped' }
      case 'running':
        return { ...base, outcome: 'waiting', running: true }
      default:
        return { ...base, outcome: 'waiting' }
    }
  })
  const tally: CheckTally = { passed: 0, issues: 0, notes: 0, dismissed: 0, skipped: 0, waiting: 0, applicable: 0 }
  for (const c of checks) {
    if (c.outcome === 'na') continue
    tally.applicable++
    if (isIssueOutcome(c.outcome)) tally.issues++
    else if (c.outcome === 'note') tally.notes++
    else if (c.outcome === 'passed') tally.passed++
    else if (c.outcome === 'dismissed') tally.dismissed++
    else if (c.outcome === 'skipped') tally.skipped++
    else tally.waiting++
  }

  const serious = open.filter((i) => {
    const s = normalizeSeverity(i.finding.severity)
    return s === 'high' || s === 'medium'
  })
  const badge = serious.length
    ? {
        count: serious.length,
        severity: serious.some((i) => normalizeSeverity(i.finding.severity) === 'high')
          ? ('high' as const)
          : ('medium' as const)
      }
    : null

  const resolved = Object.entries(state.resolved)
    .map(([id, r]) => ({ id, ...r }))
    .sort((a, b) => b.at.localeCompare(a.at))

  return {
    items,
    open,
    hidden,
    resolved,
    rules,
    checks,
    tally,
    categories,
    score: healthScore(
      open.map((i) => i.finding),
      input.deepCurrent
    ),
    badge,
    newCount: open.filter((i) => i.isNew).length
  }
}
