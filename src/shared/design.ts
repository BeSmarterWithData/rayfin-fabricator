/**
 * Design mode ("visual chat") wire protocol.
 *
 * The renderer talks to the in-preview controller
 * (`src-tauri/src/services/design_agent.js`, v6) through the Rust host, which
 * only relays these JSON documents (`preview_design_*` commands). While Design
 * is on the page owns the change queue and the renderer mirrors its snapshots;
 * while it is off the renderer owns the queue and seeds the page on enable.
 */

/** Fabricator's own theme, pushed so the in-page tools match the host app. */
export interface DesignHostTheme {
  accent: string
  accentHi?: string
  panel: string
  panel2?: string
  border?: string
  txt: string
  txtDim?: string
  /** UI zoom (1 = 100%). */
  scale?: number
}

export type DesignItemKind = 'element' | 'theme' | 'suggestion'

/** Friendly element category, used for labels and suggestion chips. */
export type DesignRole =
  | 'button'
  | 'link'
  | 'heading'
  | 'text'
  | 'image'
  | 'icon'
  | 'field'
  | 'card'
  | 'list'
  | 'item'
  | 'table'
  | 'chart'
  | 'nav'
  | 'header'
  | 'footer'
  | 'section'
  | 'container'
  | 'element'

/** A picked element, serializable and rich enough to find it again in the page
 *  and for Copilot to locate it in source. */
export interface DesignTarget {
  /** Friendly label, e.g. "Button · Add deal". */
  label: string
  role: DesignRole
  tag: string
  /** Best-effort CSS path in the live DOM. */
  selector: string
  /** Visible text (trimmed and clipped). */
  text?: string
  /** The full `class` attribute. */
  classes?: string
  /** React component name, when the build exposes one. */
  component?: string
  ariaLabel?: string
  nearestHeading?: string
  /** Enclosing landmark (header / nav / main / aside / footer / section). */
  region?: string
  /** Route (path + query + hash) the element was picked on. */
  route: string
  /** Size when picked, in CSS px. */
  box: { w: number; h: number }
  /** Graphein chart details when the element is a chart. */
  chart?: { type?: string; title?: string }
  /** `data-*` attributes (excluding the Graphein spec), capped. */
  dataAttrs?: Record<string, string>
}

export type DesignTweakKind =
  | 'text'
  | 'color'
  | 'background'
  | 'size'
  | 'weight'
  | 'spacing'
  | 'gap'
  | 'corners'
  | 'shadow'
  | 'align'
  | 'hide'
  | 'order'
  | 'variation'

/** One previewed tweak, in the app's Tailwind vocabulary when it has one, plus
 *  the CSS that produced the preview. */
export interface DesignTweak {
  kind: DesignTweakKind
  /** Human summary, e.g. "Size: sm → lg". */
  summary: string
  /** Utility swap when the element already used a matching Tailwind class. */
  tailwind?: { from?: string; to?: string }
  /** CSS the preview applied. */
  css?: { property: string; from?: string; to: string }[]
  text?: { from: string; to: string }
  /** Reorder among siblings; `steps` is the net move (negative = earlier). */
  order?: { direction: 'up' | 'down'; steps?: number; relativeTo?: string }
  /** Descendant rules an AI variation or suggestion previewed. */
  rules?: DesignRule[]
  /** Tailwind classes suggested for an AI variation. */
  classes?: string
}

/** A previewed Graphein spec change (data stripped). */
export interface DesignChartChange {
  before: Record<string, unknown>
  after: Record<string, unknown>
  summary: string[]
}

/** A previewed, app-wide theme change. */
export interface DesignThemeChange {
  accent?: { from?: string; to: string; hex?: string }
  neutral?: { from?: string; to: string }
  /** Multiplier applied to every `--radius-*` token. */
  radius?: { scale: number }
  /** `--spacing` base, e.g. 0.25rem → 0.3rem. */
  density?: { from: string; to: string }
  font?: { from?: string; to: string; stack: string }
  /** Exact CSS custom properties the preview overrode. */
  tokens: Record<string, string>
  /** A look described in words (apps without Tailwind tokens). */
  intent?: string
  summary: string[]
}

export interface DesignItem {
  id: string
  kind: DesignItemKind
  target?: DesignTarget
  /** What should change, in the user's words. */
  instruction?: string
  tweaks: DesignTweak[]
  chart?: DesignChartChange
  theme?: DesignThemeChange
  /** When set, the change applies to every element like this one. */
  similar?: number
  /** Why a Polish suggestion is worth doing. */
  why?: string
  /** The element isn't on the page currently shown (the item stays sendable). */
  missing?: boolean
  createdAt: number
}

/** Compact element context sent with a variations request. */
export interface DesignRestyleContext {
  tag: string
  text?: string
  classes?: string
  component?: string
  /** Relevant computed styles, keyed by CSS property. */
  styles: Record<string, string>
  isChart: boolean
  chartType?: string
  /** Current Graphein spec (data omitted) for charts. */
  spec?: unknown
  /** Notable descendants a variation may restyle through `rules`. */
  children?: { tag: string; classes?: string; text?: string }[]
}

/** A descendant rule inside a variation or suggestion patch. */
export interface DesignRule {
  selector: string
  styles: Record<string, string>
}

/** One AI-proposed alternative look for an element. */
export interface DesignVariation {
  name: string
  description?: string
  /** Whitelisted CSS for the element itself. */
  styles: Record<string, string>
  rules?: DesignRule[]
  /** Partial Graphein spec patch (charts only). */
  graphein?: Record<string, unknown>
  /** Tailwind classes that would produce this look. */
  classes?: string
}

/** Something the page asks the host to do on its behalf. */
export type DesignRequest = {
  id: string
  kind: 'variations'
  itemId: string
  context: DesignRestyleContext
  hint?: string
}

export interface DesignStatus {
  enabled: boolean
  /** The session the page was enabled with; `null` after a reload re-armed it
   *  unseeded (the host then re-seeds). */
  sessionId: string | null
  /** Bumped on every change, so the host fetches a snapshot only when needed. */
  version: number
  hasTheme: boolean
  itemCount: number
  requests: DesignRequest[]
  /** Results of data-returning commands, keyed by their `requestId`. */
  results: Record<string, unknown>
  panel: 'theme' | 'polish' | null
}

export interface DesignViewport {
  w: number
  h: number
  dpr: number
}

export interface DesignSnapshot {
  version: number
  /** The session the items belong to (`null` while the page is unseeded). */
  sessionId: string | null
  route: string
  viewport: DesignViewport
  items: DesignItem[]
}

export interface DesignRect {
  x: number
  y: number
  w: number
  h: number
}

/** Where each item's element sits in the captured frame (`prepareCapture`). */
export interface DesignCaptureLayout {
  viewport: DesignViewport
  /** Offset of the app frame inside the captured surface, or `null` when it
   *  can't be known (then only the full view is attached). */
  frame: { x: number; y: number } | null
  /** Visible part of each item's element, in app-viewport CSS px. */
  rects: Record<string, DesignRect>
}

export type DesignFindingKind = 'contrast' | 'tap-target' | 'overflow' | 'radius' | 'line-length'

/** A notable element on the page, as collected for a Polish pass. */
export interface DesignOutlineElement {
  ref: string
  label: string
  role: DesignRole
  tag: string
  text?: string
  classes?: string
  styles: Record<string, string>
  rect: DesignRect
}

export interface DesignPageOutline {
  route: string
  title: string
  viewport: DesignViewport
  elements: DesignOutlineElement[]
  findings: { ref?: string; kind: DesignFindingKind; message: string }[]
}

/** One AI-proposed improvement from a Polish pass. */
export interface DesignSuggestion {
  id: string
  /** Outline ref of the element it applies to. */
  ref: string
  title: string
  why: string
  /** What Copilot should do, in words. */
  instruction: string
  styles?: Record<string, string>
  rules?: DesignRule[]
}

export type DesignCommand =
  | { op: 'seed'; sessionId: string; items: DesignItem[] }
  | { op: 'removeItem'; id: string }
  | { op: 'focusItem'; id: string }
  | { op: 'clear' }
  | { op: 'openPanel'; panel: 'theme' | 'polish' | null }
  | { op: 'applyVariations'; requestId: string; options: DesignVariation[] }
  | { op: 'failRequest'; requestId: string; message: string }
  /** Tell the page what's happening with a pending request (e.g. which model is working). */
  | { op: 'requestProgress'; requestId: string; message: string }
  | { op: 'collectPage'; requestId: string }
  | { op: 'showSuggestions'; suggestions: DesignSuggestion[]; message?: string }
  | { op: 'setBusy'; message: string | null; panel?: boolean }
  | { op: 'prepareCapture'; requestId: string; ids: string[] }
  | { op: 'endCapture' }

/** Options passed when Design is switched on. */
export interface DesignEnableOptions {
  sessionId: string
  items: DesignItem[]
  hostTheme?: DesignHostTheme
  /** Show the one-time "click anything" coach mark. */
  intro?: boolean
}

/** An element to look up in the project's source (`design.locate`). */
export interface DesignLocateTarget {
  key: string
  tag?: string
  classes?: string
  text?: string
  chartTitle?: string
  chartType?: string
}

export interface DesignLocateCandidate {
  /** Project-relative path with forward slashes. */
  file: string
  /** 1-based line number. */
  line: number
  reason: string
  /** 0..1 confidence. */
  score: number
  snippet: string
}

export interface DesignLocateResult {
  /** The Tailwind entry stylesheet (the file importing `tailwindcss`). */
  entryCss?: string
  targets: { key: string; candidates: DesignLocateCandidate[] }[]
}

/** The design changes a user message carried, as shown in the transcript. */
export interface ChatDesignSummary {
  items: {
    n: number
    kind: DesignItemKind
    label: string
    summary: string
    /** Index into the message's `attachmentThumbs` of this item's crop. */
    shot?: number
  }[]
  /** Index into the message's `attachmentThumbs` of the full-view capture. */
  full?: number
}
