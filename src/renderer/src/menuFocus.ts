import type { KeyboardEvent } from 'react'

/** Arrow / Home / End navigation across a menu's enabled items. */
export function moveMenuFocus(e: KeyboardEvent<HTMLElement>, selector: string): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>(selector)).filter(
    (b) => !b.disabled
  )
  if (!items.length) return
  e.preventDefault()
  const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement))
  const next =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? items.length - 1
        : e.key === 'ArrowDown'
          ? (current + 1) % items.length
          : (current - 1 + items.length) % items.length
  items[next].focus()
}
