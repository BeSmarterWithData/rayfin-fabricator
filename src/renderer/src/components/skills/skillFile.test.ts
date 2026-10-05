import { describe, expect, it } from 'vitest'
import { parseSkillFile, splitTriggers } from './skillFile'

describe('parseSkillFile', () => {
  it('reads the description, its triggers and the body without its title', () => {
    const file = parseSkillFile(
      '\uFEFF---\r\nname: x\r\ndescription: >\r\n  Use when the app stores data.\r\n  Triggers: data, schema, data\r\n---\r\n# Data modeling\r\n\r\n## Entities\r\n- One per thing.\r\n'
    )
    expect(file.when).toBe('Use when the app stores data.')
    expect(file.triggers).toEqual(['data', 'schema'])
    expect(file.body).toBe('## Entities\n- One per thing.')
  })

  it('keeps the whole file as the body when there is no frontmatter', () => {
    expect(parseSkillFile('Just guidance.')).toEqual({ when: '', triggers: [], body: 'Just guidance.' })
  })

  it('survives frontmatter that is not valid YAML', () => {
    const file = parseSkillFile('---\ndescription: [unclosed\n---\nBody')
    expect(file.when).toBe('')
    expect(file.body).toBe('Body')
  })
})

describe('splitTriggers', () => {
  it('splits the trigger list and trims trailing punctuation', () => {
    expect(splitTriggers('Make it fast. Triggers: speed, bundle size, lazy load.')).toEqual({
      when: 'Make it fast.',
      triggers: ['speed', 'bundle size', 'lazy load']
    })
  })

  it('returns the description alone when it has no list', () => {
    expect(splitTriggers('Use when\n  building forms.')).toEqual({ when: 'Use when building forms.', triggers: [] })
  })
})
