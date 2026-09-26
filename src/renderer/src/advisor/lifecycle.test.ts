import { describe, expect, it } from 'vitest'
import type { AdvisorCondition, AdvisorFinding, AdvisorSnapshot } from '@shared/ipc'
import { CATALOG } from '@shared/advisor/catalog'
import {
  applyQuickRun,
  applyReview,
  applyVerdicts,
  coerceState,
  deriveAdvisor,
  dismiss,
  emptyState,
  markHandoffsApplied,
  markHandoffsStarted,
  mute,
  recordHandoffs,
  type DeriveInput
} from './lifecycle'
import { isCurrent, normalizeSnapshot } from './legacy'
import { gradeFor, healthScore } from './score'

function finding(id: string, over: Partial<AdvisorFinding> = {}): AdvisorFinding {
  return {
    id,
    ruleId: 'data-model/text-without-max',
    category: 'data-model',
    severity: 'high',
    source: 'quick',
    title: `Finding ${id}`,
    detail: 'd',
    recommendation: 'r',
    ...over
  }
}

const T0 = '2026-09-26T10:00:00.000Z'
const T1 = '2026-09-26T11:00:00.000Z'
const T2 = '2026-09-26T12:00:00.000Z'
const T3 = '2026-09-26T13:00:00.000Z'

function derive(over: Partial<DeriveInput>): ReturnType<typeof deriveAdvisor> {
  return deriveAdvisor({ quick: null, deep: null, live: null, state: emptyState(), deepCurrent: false, ...over })
}

describe('score', () => {
  it('maps scores to grades', () => {
    expect([95, 85, 70, 55, 10].map(gradeFor)).toEqual(['A', 'B', 'C', 'D', 'F'])
  })

  it('penalizes by severity, caps each category, and holds security highs at C', () => {
    expect(healthScore([], true)).toMatchObject({ score: 100, grade: 'A', provisional: false })
    const perf = [1, 2, 3, 4].map((i) => finding(`p${i}`, { category: 'performance', severity: 'high' }))
    expect(healthScore(perf, true).score).toBe(70)
    const one = healthScore([finding('a', { category: 'access', severity: 'high' })], false)
    expect(one).toMatchObject({ score: 85, grade: 'C', capped: true, provisional: true })
    expect(healthScore([finding('n', { severity: 'note' })], true).score).toBe(100)
  })

  it('keeps a mostly healthy app out of the failing grades', () => {
    const open = [
      finding('h', { category: 'data-model', severity: 'high' }),
      finding('m1', { category: 'queries', severity: 'medium' }),
      finding('m2', { category: 'performance', severity: 'medium' }),
      finding('m3', { category: 'accessibility', severity: 'medium' }),
      finding('m4', { category: 'accessibility', severity: 'medium' })
    ]
    expect(healthScore(open, true)).toMatchObject({ score: 65, grade: 'C', capped: false })
    expect(healthScore(open.slice(1), true)).toMatchObject({ score: 80, grade: 'B' })
    expect(healthScore(open.slice(3), true)).toMatchObject({ score: 90, grade: 'A' })
  })
})

describe('legacy snapshots', () => {
  const legacy: AdvisorSnapshot = {
    report: {
      ok: true,
      summary: 's',
      findings: [{ id: 'lead-fetch', category: 'performance', severity: 'med', title: 't', detail: 'd', recommendation: 'r', ruleId: '', source: 'ai' }]
    },
    analyzedAt: T0,
    durationMs: 1,
    stale: false
  }

  it('maps old categories and marks the review as not current', () => {
    const snap = normalizeSnapshot(legacy)
    expect(snap.legacy).toBe(true)
    expect(snap.report.findings[0]).toMatchObject({
      id: 'legacy:lead-fetch',
      ruleId: 'legacy/performance',
      category: 'performance',
      severity: 'medium'
    })
    expect(isCurrent(snap)).toBe(false)
    expect(normalizeSnapshot({ ...legacy, report: { ...legacy.report, findings: [{ ...legacy.report.findings[0], category: 'auth' }] } }).report.findings[0].category).toBe('access')
  })

  it('treats a review from another rule catalog as outdated', () => {
    const snap = normalizeSnapshot({ ...legacy, schemaVersion: 2, catalogVersion: 'old' })
    expect(snap.rulesChanged).toBe(true)
    expect(isCurrent(snap)).toBe(false)
    expect(isCurrent(normalizeSnapshot({ ...legacy, schemaVersion: 2, catalogVersion: CATALOG.catalogVersion }))).toBe(true)
  })
})

describe('quick-check lifecycle', () => {
  it('sets a baseline on the first run and resolves findings that disappear', () => {
    let state = applyQuickRun(emptyState(), [finding('a'), finding('b')], T0)
    expect(Object.keys(state.baseline!.entries)).toEqual(['a', 'b'])
    state = applyQuickRun(state, [finding('a'), finding('c')], T1)
    expect(state.resolved.b).toMatchObject({ via: 'quick', at: T1 })
    const view = derive({ quick: { findings: [finding('a'), finding('c')], results: [] }, state })
    expect(view.items.find((i) => i.finding.id === 'c')!.isNew).toBe(true)
    expect(view.items.find((i) => i.finding.id === 'a')!.isNew).toBe(false)
    expect(view.resolved.map((r) => r.id)).toEqual(['b'])
    // A finding that comes back is no longer resolved.
    state = applyQuickRun(state, [finding('a'), finding('b')], T2)
    expect(state.resolved.b).toBeUndefined()
  })

  it('tracks Copilot hand-offs from fixing to resolved or still detected', () => {
    let state = applyQuickRun(emptyState(), [finding('a'), finding('b')], T0)
    state = recordHandoffs(state, [finding('a'), finding('b')], T0)
    const quick = (ranAt: string, ids: string[]) => ({ findings: ids.map((id) => finding(id)), results: [], ranAt })
    expect(derive({ quick: quick(T0, ['a', 'b']), state }).items.map((i) => i.status)).toEqual(['fixing', 'fixing'])
    state = markHandoffsApplied(markHandoffsStarted(state), T1)
    expect(derive({ quick: quick(T0, ['a', 'b']), state }).items[0].status).toBe('checking')
    state = applyQuickRun(state, [finding('b')], T2)
    const view = derive({ quick: quick(T2, ['b']), state })
    expect(view.items.map((i) => [i.finding.id, i.status])).toEqual([['b', 'still']])
    expect(view.resolved[0]).toMatchObject({ id: 'a', fixedByCopilot: true })
  })

  it('hides dismissed findings and muted rules from the open list, score, and badge', () => {
    const a = finding('a', { category: 'access' })
    const b = finding('b', { ruleId: 'queries/count-method', category: 'queries', severity: 'medium' })
    let state = dismiss(emptyState(), a, 'accepted-risk', T0, 'intended')
    state = mute(state, 'queries/count-method', T0)
    const view = derive({ quick: { findings: [a, b], results: [] }, state })
    expect(view.open).toEqual([])
    expect(view.hidden.map((i) => i.status)).toEqual(['dismissed', 'muted'])
    expect(view.badge).toBeNull()
    expect(view.score.score).toBe(100)
    // Dismissed findings that disappear don't count as resolved.
    expect(applyQuickRun(applyQuickRun(state, [a], T1), [], T2).resolved).toEqual({})
  })
})

describe('deep-review lifecycle', () => {
  const ai = (id: string) => finding(id, { source: 'ai', ruleId: 'queries/unpaginated-list', category: 'queries' })

  it('does not call first-review findings new, but marks new findings in later reviews', () => {
    let state = applyQuickRun(emptyState(), [], T0)
    state = applyReview(state, [], [ai('x')], [], T1)
    expect(derive({ deep: snap([ai('x')]), state }).items[0].isNew).toBe(false)
    state = applyReview(state, [ai('x')], [ai('x'), ai('y')], [], T2)
    const view = derive({ deep: snap([ai('x'), ai('y')]), state })
    expect(view.items.find((i) => i.finding.id === 'y')!.isNew).toBe(true)
    expect(view.items.find((i) => i.finding.id === 'x')!.isNew).toBe(false)
    state = applyReview(state, [ai('x'), ai('y')], [ai('y')], [], T3)
    expect(state.resolved.x).toMatchObject({ via: 'review' })
  })

  it('resolves verified fixes and keeps findings verify says are still present', () => {
    const x = ai('x')
    const y = ai('y')
    let state = recordHandoffs(emptyState(), [x, y], T0)
    state = markHandoffsApplied(markHandoffsStarted(state), T1)
    expect(derive({ deep: snap([x, y]), state }).items.map((i) => i.status)).toEqual(['applied', 'applied'])
    state = applyVerdicts(
      state,
      [
        { findingId: 'x', status: 'fixed' },
        { findingId: 'y', status: 'present', note: 'still unpaginated' }
      ],
      [x, y],
      T2
    )
    const view = derive({ deep: snap([x, y]), state })
    expect(view.items.map((i) => [i.finding.id, i.status])).toEqual([['y', 'still']])
    expect(view.resolved[0]).toMatchObject({ id: 'x', via: 'verify', fixedByCopilot: true })
  })

  it('shows live findings instead of the saved review while a review runs', () => {
    const view = derive({
      deep: snap([ai('old')]),
      live: { findings: [ai('new')], results: [{ ruleId: 'queries/unpaginated-list', status: 'fail' }] },
      state: emptyState()
    })
    expect(view.items.map((i) => i.finding.id)).toEqual(['new'])
    expect(view.rules.get('policy/sensitive-field-exposed')!.status).toBe('running')
  })
})

describe('category summaries', () => {
  it('reports failing, passing, pending, and not-applicable categories', () => {
    const quick = {
      findings: [finding('a')],
      results: [
        { ruleId: 'data-model/text-without-max', status: 'fail' as const },
        { ruleId: 'config/data-dialect', status: 'pass' as const },
        { ruleId: 'platform/functions-mssql', status: 'na' as const }
      ]
    }
    const view = derive({ quick })
    const cat = (id: string) => view.categories.find((c) => c.id === id)!
    expect(cat('data-model')).toMatchObject({ state: 'fail', issues: 1 })
    expect(cat('config').passed).toBe(1)
    expect(cat('accessibility').pending).toBeGreaterThan(0)
    expect(view.badge).toEqual({ count: 1, severity: 'high' })
  })

  it('treats deep-review rules for services the app does not use as not applicable', () => {
    const quick = { findings: [], results: [], conditions: ['data', 'auth'] as AdvisorCondition[] }
    const idle = derive({ quick })
    expect(idle.rules.get('platform/connector-wiring')!.status).toBe('na')
    expect(idle.rules.get('platform/functions-unregistered')!.status).toBe('na')
    expect(idle.rules.get('queries/unpaginated-list')!.status).toBe('pending')
    const running = derive({ quick, live: { findings: [], results: [] } })
    expect(running.rules.get('platform/connector-wiring')!.status).toBe('na')
    expect(running.rules.get('queries/unpaginated-list')!.status).toBe('running')
    const reviewed = derive({ quick, deep: snap([]) })
    expect(reviewed.categories.find((c) => c.id === 'platform')!.pending).toBe(1)
  })
})

describe('checks and tally', () => {
  it('gives every applicable rule one outcome', () => {
    const quick = {
      findings: [finding('quick:data-model/text-without-max'), finding('quick:policy/prefer-shorthand', { ruleId: 'policy/prefer-shorthand', category: 'policy', severity: 'note' })],
      results: [
        { ruleId: 'data-model/text-without-max', status: 'fail' as const },
        { ruleId: 'policy/prefer-shorthand', status: 'fail' as const },
        { ruleId: 'config/data-dialect', status: 'pass' as const },
        { ruleId: 'platform/cli-outdated', status: 'skipped' as const, note: 'Offline' },
        { ruleId: 'platform/functions-mssql', status: 'na' as const }
      ],
      conditions: ['data', 'auth'] as AdvisorCondition[]
    }
    const view = derive({ quick })
    const check = (id: string) => view.checks.find((c) => c.ruleId === id)!
    expect(check('data-model/text-without-max')).toMatchObject({ outcome: 'high', findingId: 'quick:data-model/text-without-max' })
    expect(check('policy/prefer-shorthand').outcome).toBe('note')
    expect(check('config/data-dialect').outcome).toBe('passed')
    expect(check('platform/cli-outdated')).toMatchObject({ outcome: 'skipped', note: 'Offline' })
    expect(check('platform/functions-mssql').outcome).toBe('na')
    expect(check('platform/connector-wiring').outcome).toBe('na')
    expect(check('queries/unpaginated-list')).toMatchObject({ outcome: 'waiting' })
    expect(view.checks).toHaveLength(CATALOG.rules.length)
    expect(view.tally).toMatchObject({ issues: 1, notes: 1, passed: 1, skipped: 1, dismissed: 0 })
    expect(view.tally.waiting).toBe(view.checks.filter((c) => c.outcome === 'waiting').length)
    expect(view.tally.applicable).toBe(view.checks.filter((c) => c.outcome !== 'na').length)
    expect(view.categories.find((c) => c.id === 'platform')!.skipped).toBe(1)
  })

  it('marks dismissed or muted rules and live rules as running', () => {
    const quick = {
      findings: [finding('quick:data-model/text-without-max')],
      results: [{ ruleId: 'data-model/text-without-max', status: 'fail' as const }]
    }
    const hidden = derive({ quick, state: dismiss(emptyState(), quick.findings[0], 'accepted-risk', T1) })
    expect(hidden.checks.find((c) => c.ruleId === 'data-model/text-without-max')!.outcome).toBe('dismissed')
    expect(hidden.tally.dismissed).toBe(1)
    const muted = derive({ quick, state: mute(emptyState(), 'data-model/text-without-max', T1) })
    expect(muted.checks.find((c) => c.ruleId === 'data-model/text-without-max')!.outcome).toBe('dismissed')
    const running = derive({ quick, live: { findings: [], results: [] } })
    expect(running.checks.find((c) => c.ruleId === 'queries/unpaginated-list')).toMatchObject({ outcome: 'waiting', running: true })
  })
})

describe('coerceState', () => {
  it('tolerates missing or malformed state', () => {
    expect(coerceState(null)).toEqual(emptyState())
    expect(coerceState({ dismissed: [], muted: { r: { at: T0 } } }).muted).toEqual({ r: { at: T0 } })
  })
})

function snap(findings: AdvisorFinding[]) {
  return normalizeSnapshot({
    schemaVersion: 2,
    catalogVersion: CATALOG.catalogVersion,
    report: { ok: true, summary: '', findings, rules: [] },
    analyzedAt: T1,
    durationMs: 1,
    stale: false
  })
}
