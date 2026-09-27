/** Preview widths offered while designing. `width` is in app CSS px. */
export type DeviceId = 'desktop' | 'tablet' | 'phone'

export interface DevicePreset {
  id: DeviceId
  label: string
  /** App viewport width in CSS px; `null` fills the pane. */
  width: number | null
}

export const DEVICES: DevicePreset[] = [
  { id: 'desktop', label: 'Desktop', width: null },
  { id: 'tablet', label: 'Tablet', width: 820 },
  { id: 'phone', label: 'Phone', width: 390 }
]

export function devicePreset(id: DeviceId): DevicePreset {
  return DEVICES.find((d) => d.id === id) ?? DEVICES[0]
}

/**
 * The preview host's CSS width for a device, in renderer px. The native preview
 * follows the renderer's zoom, so an app width of `w` CSS px needs `w / uiScale`
 * renderer px. `null` means "fill the pane".
 */
export function deviceHostWidth(id: DeviceId, uiScale: number): number | null {
  const preset = devicePreset(id)
  if (!preset.width) return null
  const scale = Number.isFinite(uiScale) && uiScale > 0 ? uiScale : 1
  return Math.round(preset.width / scale)
}
