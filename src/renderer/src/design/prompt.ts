import type {
  ChatDesignSummary,
  DesignItem,
  DesignLocateResult,
  DesignTweak,
  DesignViewport
} from '@shared/design'

function clip(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s
}

/** A short title for an item: the element's label, or "Theme". */
export function itemTitle(item: DesignItem): string {
  if (item.kind === 'theme') return 'Theme'
  return item.target?.label ?? 'Element'
}

/** One line describing everything an item asks for (chips and the transcript card). */
export function itemSummary(item: DesignItem): string {
  const parts: string[] = []
  if (item.instruction) parts.push(`“${clip(item.instruction, 80)}”`)
  if (item.kind === 'theme' && item.theme) {
    parts.push(...item.theme.summary.filter((line) => !line.startsWith('Look: ') || !item.instruction))
  }
  for (const t of item.tweaks) parts.push(t.summary)
  if (item.chart) parts.push(...item.chart.summary.map((line) => `Chart ${line}`))
  if (item.similar) parts.push(`+${item.similar} like it`)
  return parts.join(' · ') || 'No changes yet'
}

export function summarizeDesign(items: DesignItem[]): ChatDesignSummary {
  return {
    items: items.map((item, i) => ({ n: i + 1, kind: item.kind, label: itemTitle(item), summary: clip(itemSummary(item), 240) }))
  }
}

function tweakLine(t: DesignTweak): string {
  const bits = [t.summary]
  if (t.tailwind?.to) bits.push(`Tailwind: ${t.tailwind.from ?? '(none)'} → ${t.tailwind.to}`)
  if (t.classes) bits.push(`suggested classes: ${t.classes}`)
  const css = (t.css ?? []).map((c) => `${c.property}: ${clip(c.to, 90)}`).join('; ')
  if (css) bits.push(`previewed CSS: ${css}`)
  if (t.rules?.length) {
    bits.push(
      `inside it: ${t.rules
        .map((r) => `${r.selector} { ${Object.entries(r.styles).map(([k, v]) => `${k}: ${v}`).join('; ')} }`)
        .join(' ')}`
    )
  }
  if (t.order?.relativeTo) bits.push(`${t.order.direction === 'up' ? 'before' : 'after'} ${t.order.relativeTo}`)
  return bits.join(' — ')
}

function elementLine(item: DesignItem): string | null {
  const t = item.target
  if (!t) return null
  const bits = [`<${t.tag}${t.classes ? ` class="${clip(t.classes, 220)}"` : ''}>`]
  if (t.text) bits.push(`text “${clip(t.text, 80)}”`)
  if (t.component) bits.push(`component <${t.component}>`)
  if (t.ariaLabel) bits.push(`aria-label “${t.ariaLabel}”`)
  if (t.nearestHeading) bits.push(`near heading “${t.nearestHeading}”`)
  if (t.region) bits.push(`inside <${t.region}>`)
  if (t.chart) bits.push(`Graphein ${t.chart.type ?? ''} chart${t.chart.title ? ` titled “${t.chart.title}”` : ''}`.replace('  ', ' '))
  bits.push(`selector ${t.selector}`)
  return bits.join(' · ')
}

function json(value: unknown, max: number): string {
  const text = JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export interface DesignPromptInput {
  /** What the user typed in the composer (optional). */
  note: string
  items: DesignItem[]
  locate?: DesignLocateResult | null
  route?: string
  viewport?: DesignViewport
  /** A full-view screenshot (with previews) is attached first. */
  fullView?: boolean
  /** Item ids with an element crop attached, in attachment order after the full view. */
  crops?: string[]
  /** Screenshots the user attached themselves, sent after the design captures. */
  extraImages?: number
}

/**
 * The hidden, structured prompt a design turn sends to Copilot. The transcript
 * shows the user's note and a summary card instead (see {@link summarizeDesign}).
 */
export function composeDesignPrompt(input: DesignPromptInput): string {
  const { items, locate } = input
  const lines: string[] = []
  const note = input.note.trim()
  lines.push(note || 'Please apply these design changes to my app.')
  lines.push('')
  const where = [input.route ? `route ${input.route}` : '', input.viewport ? `viewport ${input.viewport.w}×${input.viewport.h}` : '']
    .filter(Boolean)
    .join(', ')
  lines.push(`## Design changes from the live preview (${items.length})`)
  lines.push(
    `I pointed at these in the running app${where ? ` (${where})` : ''}. Previewed tweaks were temporary CSS overrides in the preview — not source edits — showing the result I want.`
  )
  const images: string[] = []
  let n = 1
  if (input.fullView) images.push(`#${n++} is the full view with the changes previewed`)
  const cropped = (input.crops ?? []).map((id) => items.findIndex((it) => it.id === id) + 1).filter((i) => i > 0)
  if (cropped.length) {
    images.push(`#${n}${cropped.length > 1 ? `–#${n + cropped.length - 1}` : ''} ${cropped.length > 1 ? 'are crops of changes' : 'is a crop of change'} ${cropped.join(', ')}`)
    n += cropped.length
  }
  const extra = input.extraImages ?? 0
  if (extra > 0 && images.length) {
    images.push(`${extra > 1 ? `#${n}–#${n + extra - 1} are screenshots` : `#${n} is a screenshot`} I attached myself`)
  }
  if (images.length) lines.push(`Attached images: ${images.join('; ')}.`)

  items.forEach((item, i) => {
    lines.push('')
    const scope = item.similar ? ` — scope: this element and ${item.similar} more like it` : item.kind === 'theme' ? ' — scope: the whole app' : ''
    lines.push(`### ${i + 1}. ${itemTitle(item)}${item.kind === 'suggestion' ? ' (suggested by a design review)' : ''}${scope}`)
    if (item.instruction) lines.push(`- Request: “${item.instruction.trim()}”`)
    if (item.why) lines.push(`- Why: ${item.why}`)
    if (item.tweaks.length) {
      lines.push('- Previewed tweaks:')
      for (const t of item.tweaks) lines.push(`  - ${tweakLine(t)}`)
    }
    if (item.chart) {
      lines.push(`- Chart spec change (data omitted): ${item.chart.summary.join('; ')}`)
      lines.push(`  - before: ${json(item.chart.before, 1500)}`)
      lines.push(`  - after: ${json(item.chart.after, 1500)}`)
    }
    if (item.kind === 'theme' && item.theme) {
      if (item.theme.summary.length) lines.push(`- Theme: ${item.theme.summary.join('; ')}`)
      if (Object.keys(item.theme.tokens).length) lines.push(`- Exact token overrides previewed: ${json(item.theme.tokens, 2400)}`)
      if (locate?.entryCss) lines.push(`- Tailwind entry stylesheet: ${locate.entryCss}`)
    }
    const element = elementLine(item)
    if (element) lines.push(`- Element: ${element}`)
    const hints = locate?.targets.find((t) => t.key === item.id)?.candidates ?? []
    if (hints.length) lines.push(`- Likely source: ${hints.map((c) => `${c.file}:${c.line} (${c.reason})`).join(', ')}`)
    if (item.missing) lines.push(`- This element isn't on the page currently shown${item.target?.route ? ` (it was on ${item.target.route})` : ''}.`)
  })

  lines.push('')
  lines.push('## How to apply')
  lines.push('- Find each element in the source — start at the likely locations (heuristic hints, not guarantees); the classes and selectors above come from the production DOM.')
  lines.push('- Implement previewed tweaks with the project’s Tailwind utilities (the from → to classes above) rather than inline styles, and keep `dark:` and responsive variants consistent.')
  lines.push('- Without a scope note, change only this usage (for example through a prop or className at the call site); with “and N more like it”, change the shared component or pattern.')
  lines.push('- “Remove this element” means deleting it from the UI (and code that becomes unused); a move means reordering it in the source.')
  if (items.some((it) => it.kind === 'theme')) {
    lines.push('- Theme: set scale tokens (`--spacing`, `--radius-*`, `--font-sans`) in the `@theme` block of the Tailwind entry stylesheet; for an accent or neutral swap, replace that palette’s utility classes consistently (or add a brand token mapped to the new colors).')
  }
  if (items.some((it) => it.chart)) lines.push('- Chart changes: update the Graphein spec where it is built, keeping its data wiring.')
  lines.push('- Make only these changes and keep the project building. Finish with a short summary per change number.')
  return lines.join('\n')
}
