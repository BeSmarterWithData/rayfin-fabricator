import { describe, expect, it } from 'vitest'
import { LineIndex, maskComments, parseDataModel, readSchemaTypeNames } from './parseSchema'

const TODO = [
  "import { entity, authenticated, uuid, text } from '@microsoft/rayfin-core';",
  '/* The todo item.',
  '   Spans two lines. */',
  '@entity()',
  "@authenticated('*', { policy: (claims, item) => claims.sub.eq(item.user_id) })",
  'export class Todo {',
  '  @uuid() id!: string;',
  '  // a comment with @text() in it',
  '  @text({ max: 200 }) title!: string;',
  '  @text({ optional: true, max: 20 }) tag?: string;',
  '}',
  ''
].join('\n')

describe('maskComments', () => {
  it('blanks comments while keeping offsets, newlines, and strings', () => {
    const src = "a // c\nb /* x\ny */ c 'http://keep'"
    const masked = maskComments(src)
    expect(masked).toHaveLength(src.length)
    expect(masked.split('\n')).toHaveLength(src.split('\n').length)
    expect(masked).not.toContain('c\nb /*')
    expect(masked).toContain("'http://keep'")
  })
})

describe('LineIndex', () => {
  it('maps offsets to 1-based lines', () => {
    const lines = new LineIndex('a\nbb\nccc')
    expect(lines.lineAt(0)).toBe(1)
    expect(lines.lineAt(2)).toBe(2)
    expect(lines.lineAt(5)).toBe(3)
  })
})

describe('parseDataModel line numbers', () => {
  it('records class, decorator, and field lines past comments', async () => {
    const files: Record<string, string> = {
      'rayfin/data/schema.ts': "import { Todo } from './Todo.js';\nexport const schema = [Todo];\n",
      'rayfin/data/Todo.ts': TODO
    }
    const model = await parseDataModel(async (p) => files[p] ?? null)
    const todo = model.entities[0]
    expect(todo.line).toBe(6)
    expect(todo.decorators?.map((d) => [d.name, d.line])).toEqual([
      ['entity', 4],
      ['authenticated', 5]
    ])
    const title = todo.fields.find((f) => f.name === 'title')!
    expect(title.line).toBe(9)
    expect(title.decorators?.[0]).toMatchObject({ name: 'text', line: 9 })
    const tag = todo.fields.find((f) => f.name === 'tag')!
    expect(tag.markedOptional).toBe(true)
    expect(tag.optionFlag).toBe(true)
    expect(todo.fields.map((f) => f.name)).toEqual(['id', 'title', 'tag'])
  })
})

describe('readSchemaTypeNames', () => {
  it('prefers the exported type that matches the schema array', () => {
    const src =
      'export type NoteRecord = { id: string; body: string };\nexport type AppSchema = { Note: Note; Tag: Tag };\nexport const schema = [Note, Tag];\n'
    expect(readSchemaTypeNames(src, ['Note', 'Tag'])).toMatchObject({ typeName: 'AppSchema', names: ['Note', 'Tag'] })
  })
})
