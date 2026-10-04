import type { ReasoningEffort } from '@shared/ipc'

/** Reasoning efforts shown when the engine's per-model list is unavailable
 * (offline / pre-fetch / signed-out). Also defines the canonical display order. */
export const EFFORT_OPTIONS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const EFFORT_ORDER: ReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max']
