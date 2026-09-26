import catalogJson from './rules.json'
import type {
  AdvisorCatalog,
  AdvisorCategoryDef,
  AdvisorCategoryId,
  AdvisorCondition,
  AdvisorRuleDef,
  AdvisorSeverity
} from './types'

/** The shared rule catalog (also compiled into the Rust backend). */
export const CATALOG = catalogJson as unknown as AdvisorCatalog

export const RULES: readonly AdvisorRuleDef[] = CATALOG.rules
export const QUICK_RULES: readonly AdvisorRuleDef[] = RULES.filter((r) => r.engine === 'quick')
export const AI_RULES: readonly AdvisorRuleDef[] = RULES.filter((r) => r.engine === 'ai')
export const CATEGORIES: readonly AdvisorCategoryDef[] = CATALOG.categories

const RULE_INDEX = new Map(RULES.map((r) => [r.id, r]))
const CATEGORY_INDEX = new Map(CATEGORIES.map((c) => [c.id, c]))

export function ruleById(id: string): AdvisorRuleDef | undefined {
  return RULE_INDEX.get(id)
}

export function categoryById(id: string): AdvisorCategoryDef | undefined {
  return CATEGORY_INDEX.get(id as AdvisorCategoryId)
}

/** A rule applies when it has no conditions or any of them holds. */
export function ruleApplies(rule: AdvisorRuleDef, conditions: ReadonlySet<AdvisorCondition>): boolean {
  return !rule.appliesWhen?.length || rule.appliesWhen.some((c) => conditions.has(c))
}

/** Categories used by reviews saved before the rule catalog existed. */
const LEGACY_CATEGORIES: Record<string, AdvisorCategoryId> = {
  auth: 'access',
  policy: 'policy',
  version: 'platform',
  'data-modeling': 'data-model',
  performance: 'performance',
  accessibility: 'accessibility'
}

/** Map any category key (current or legacy) to a catalog category, if possible. */
export function normalizeCategory(key: string): AdvisorCategoryId | undefined {
  if (CATEGORY_INDEX.has(key as AdvisorCategoryId)) return key as AdvisorCategoryId
  return LEGACY_CATEGORIES[key]
}

/** Normalize model- or legacy-supplied severities (`med`, `critical`, …). */
export function normalizeSeverity(value: string | undefined): AdvisorSeverity {
  const s = (value ?? '').trim().toLowerCase()
  if (s === 'high' || s === 'critical') return 'high'
  if (s === 'low') return 'low'
  if (s === 'note' || s === 'info' || s === 'informational') return 'note'
  return 'medium'
}

const SEVERITY_ORDER: Record<AdvisorSeverity, number> = { high: 0, medium: 1, low: 2, note: 3 }

export function severityRank(value: string | undefined): number {
  return SEVERITY_ORDER[normalizeSeverity(value)]
}

export function severityLabel(value: string | undefined): string {
  switch (normalizeSeverity(value)) {
    case 'high':
      return 'High'
    case 'low':
      return 'Low'
    case 'note':
      return 'Note'
    default:
      return 'Medium'
  }
}
