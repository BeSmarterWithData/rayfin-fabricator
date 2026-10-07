import { describe, expect, it } from 'vitest'
import { branchLabel } from './statusbar'

describe('showing a team working branch', () => {
  it('drops the uniqueness stamp and keeps the app folder', () => {
    expect(branchLabel('fabricator/sachi/triplogger-20261006-063237')).toBe('triplogger')
  })

  it('keeps a folder name that contains digits and dashes', () => {
    expect(branchLabel('fabricator/sachi/expenses-2026-tracker-20261006-063237')).toBe(
      'expenses-2026-tracker'
    )
  })

  it('leaves a branch without a stamp alone', () => {
    expect(branchLabel('fabricator/sachi/triplogger')).toBe('triplogger')
    expect(branchLabel('main')).toBe('main')
  })

  it('only strips a stamp at the end', () => {
    expect(branchLabel('fabricator/sachi/20261006-063237-triplogger')).toBe(
      '20261006-063237-triplogger'
    )
  })
})
