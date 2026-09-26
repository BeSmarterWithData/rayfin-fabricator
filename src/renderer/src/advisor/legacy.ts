/**
 * Normalizes saved deep reviews for display, including reviews saved before the
 * rule catalog existed (schema v1: free-form categories, no rule ids).
 */
import type { AdvisorFinding, AdvisorSnapshot } from '@shared/ipc'
import { CATALOG, normalizeCategory, normalizeSeverity, ruleById } from '@shared/advisor/catalog'

export interface NormalizedSnapshot extends AdvisorSnapshot {
  /** Saved before the rule catalog; findings map to categories but not rules. */
  legacy: boolean
  /** The rule catalog changed since this review ran. */
  rulesChanged: boolean
}

function normalizeFinding(f: AdvisorFinding, index: number, legacy: boolean): AdvisorFinding {
  const rule = f.ruleId ? ruleById(f.ruleId) : undefined
  const category = rule?.category ?? normalizeCategory(f.category) ?? f.category ?? 'other'
  return {
    ...f,
    id: legacy ? `legacy:${f.id?.trim() || index}` : f.id || `ai:${f.ruleId}:${index}`,
    ruleId: rule ? rule.id : f.ruleId || `legacy/${category}`,
    category,
    severity: normalizeSeverity(f.severity),
    source: 'ai',
    recommendation: f.recommendation ?? '',
    detail: f.detail ?? ''
  }
}

export function normalizeSnapshot(snapshot: AdvisorSnapshot): NormalizedSnapshot {
  const legacy = !snapshot.schemaVersion || snapshot.schemaVersion < 2
  return {
    ...snapshot,
    legacy,
    rulesChanged: !legacy && snapshot.catalogVersion !== CATALOG.catalogVersion,
    report: {
      ...snapshot.report,
      findings: (snapshot.report.findings ?? []).map((f, i) => normalizeFinding(f, i, legacy))
    }
  }
}

/** Whether a deep review still reflects the current code and rules. */
export function isCurrent(snapshot: NormalizedSnapshot | null): boolean {
  return Boolean(snapshot && snapshot.report.ok && !snapshot.stale && !snapshot.legacy && !snapshot.rulesChanged)
}
