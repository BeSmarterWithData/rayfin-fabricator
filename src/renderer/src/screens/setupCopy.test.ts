import { describe, expect, it } from 'vitest'
import { progressLine, toolLine, toolPurpose, toolState } from './setupCopy'

const base = { id: 'node', satisfied: false, found: false, required: true }

describe('saying what a tool is for', () => {
  it('explains a known tool without jargon', () => {
    expect(toolPurpose('git')).toBe('Keeps a history of your app so you can always go back')
    expect(toolPurpose('node')).not.toMatch(/CLI|command.line|runtime/i)
  })

  it('falls back to the backend hint rather than inventing something', () => {
    expect(toolPurpose('unknown-tool', 'Install the thing.')).toBe('Install the thing.')
  })

  it('still says something when there is no hint at all', () => {
    expect(toolPurpose('unknown-tool')).toBe('Used by Fabricator behind the scenes')
  })
})

describe('the line under a tool name', () => {
  it('shows only the version once a tool works', () => {
    expect(toolLine({ ...base, satisfied: true, found: true, version: '24.1.0' })).toBe('24.1.0')
  })

  it('names both what is installed and what is needed when outdated', () => {
    const line = toolLine({ ...base, found: true, version: '18.20.4', minVersion: '20' })
    expect(line).toContain('18.20.4')
    expect(line).toContain('20 or newer')
  })

  it('does not print a null version at the user', () => {
    const line = toolLine({ ...base, found: true, version: null, minVersion: '20' })
    expect(line).not.toContain('null')
    expect(line).toContain('unknown')
  })

  it('explains the purpose when a tool is missing entirely', () => {
    expect(toolLine({ ...base, id: 'git' })).toBe(
      'Keeps a history of your app so you can always go back'
    )
  })
})

describe('the one-word state', () => {
  it.each([
    [{ satisfied: true, found: true, required: true }, 'Ready', 'ok'],
    [{ satisfied: false, found: true, required: true }, 'Needs updating', 'warn'],
    [{ satisfied: false, found: false, required: true }, 'Missing', 'bad'],
    [{ satisfied: false, found: false, required: false }, 'Optional', 'muted']
  ])('reads %o as %s', (tool, word, tone) => {
    expect(toolState(tool)).toEqual({ word, tone })
  })
})

describe('the progress line', () => {
  it('says what is happening while checking', () => {
    expect(progressLine(0, 7, true)).toContain('Checking')
  })

  it('invites you in rather than listing zero of seven', () => {
    expect(progressLine(0, 7, false)).toContain("Let's get Fabricator set up")
  })

  it('counts what is left, in plain words', () => {
    expect(progressLine(6, 7, false)).toBe('1 thing left to set up.')
    expect(progressLine(4, 7, false)).toBe('3 things left to set up.')
  })

  it('tells you that you are done', () => {
    expect(progressLine(7, 7, false)).toContain('You can start building')
  })
})
