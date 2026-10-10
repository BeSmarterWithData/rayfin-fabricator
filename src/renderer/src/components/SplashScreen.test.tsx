import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import SplashScreen from './SplashScreen'
import { SPLASH_LINES, splashGreeting } from './mascot/lines'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  localStorage.clear()
})

const said = (): string => screen.getByRole('status').textContent ?? ''
/** Let `ms` pass in small steps, so React catches up between timers as it would live. */
function wait(ms: number): void {
  for (let t = 0; t < ms; t += 100) act(() => void vi.advanceTimersByTime(100))
}

describe('SplashScreen', () => {
  it('is Ray’s while he is on, and builds the Fabricator mark when he is off', () => {
    const { container, unmount } = render(<SplashScreen />)
    expect(container.querySelector('.ray-perch-ray svg.ray')).not.toBeNull()
    expect(container.querySelector('.splash-logo')).toBeNull()
    unmount()

    const off = render(<SplashScreen mascot={false} />)
    expect(off.container.querySelector('.splash-logo')).not.toBeNull()
    expect(off.container.querySelector('svg.ray')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('introduces Ray first, holding his hello long enough to read', () => {
    const { rerender, unmount } = render(<SplashScreen stage="tools" />)
    expect(said()).toBe(splashGreeting(true))
    rerender(<SplashScreen stage="ready" />)
    wait(1000)
    expect(said()).toBe(splashGreeting(true))
    wait(700)
    expect(said()).toBe(SPLASH_LINES.ready[0])
    unmount()

    // Met now: next time he just says hello.
    render(<SplashScreen stage="tools" />)
    expect(said()).toBe(splashGreeting(false))
  })

  it('keeps talking while a step takes a while', () => {
    render(<SplashScreen stage="accounts" />)
    wait(1700)
    expect(said()).toBe(SPLASH_LINES.accounts[0])
    wait(2000)
    expect(said()).toBe(SPLASH_LINES.accounts[1])
  })
})
