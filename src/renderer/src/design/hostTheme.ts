import type { DesignHostTheme } from '@shared/design'

/**
 * Fabricator's own theme (accent / surfaces / text / border) + UI zoom, read from
 * the renderer's CSS tokens so the in-preview Design tools match the host app's
 * look and scale (the tools are Fabricator UI, not the previewed app's). Falls
 * back to the dark-teal defaults when a token is missing.
 */
export function readFabricatorTheme(): DesignHostTheme {
  const cs = getComputedStyle(document.documentElement)
  const v = (n: string): string => cs.getPropertyValue(n).trim()
  const scale = Number(v('--ui-scale') || document.documentElement.style.zoom) || 1
  return {
    accent: v('--accent') || '#34b4ba',
    accentHi: v('--accent-2') || undefined,
    panel: v('--bg-elev') || '#12161f',
    panel2: v('--bg-elev-2') || undefined,
    border: v('--border') || undefined,
    txt: v('--text') || '#eceff5',
    txtDim: v('--text-dim') || undefined,
    scale
  }
}
