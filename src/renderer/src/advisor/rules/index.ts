import type { QuickRuleImpl } from '../quick'
import { accessRules } from './access'
import { configRules } from './config'
import { dataModelRules } from './dataModel'
import { frontendRules } from './frontend'
import { platformRules } from './platform'
import { policyRules } from './policy'
import { queryRules } from './queries'
import { secretRules } from './secrets'

/** Every quick-check implementation, keyed by catalog rule id. */
export const QUICK_IMPLS: ReadonlyMap<string, QuickRuleImpl> = new Map(
  [
    ...accessRules,
    ...policyRules,
    ...secretRules,
    ...dataModelRules,
    ...queryRules,
    ...configRules,
    ...platformRules,
    ...frontendRules
  ].map((impl) => [impl.id, impl])
)
