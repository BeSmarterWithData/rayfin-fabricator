import { describe, expect, it } from 'vitest'
import { composeDiffs, formatUnifiedDiff, parseUnifiedDiff, type DiffFile } from './diff'

// Shapes copied from real Copilot `detailedContent` payloads.
const EDIT = [
  'diff --git a/C:/p/src/main.tsx b/C:/p/src/main.tsx',
  'index 0000000..0000000 100644',
  '--- a/C:/p/src/main.tsx',
  '+++ b/C:/p/src/main.tsx',
  '@@ -43,7 +43,8 @@ export function App()',
  '   lastDeploy: { url: "x" }',
  ' }',
  ' ',
  '-const seed = load()',
  '+const pendingMode = params.get("pending")',
  '+const seed = load(pendingMode)',
  ' ',
  ' function App() {',
  ' ',
  '\\ No newline at end of file'
].join('\n')

const CREATE = [
  'diff --git a/C:/p/answer.txt b/C:/p/answer.txt',
  'create file mode 100644',
  'index 0000000..0000000',
  '--- a/dev/null',
  '+++ b/C:/p/answer.txt',
  '@@ -1,0 +1,2 @@',
  '+0.05',
  '+done'
].join('\n')

describe('parseUnifiedDiff', () => {
  it('parses an edit with line numbers, section, and stats', () => {
    const [file] = parseUnifiedDiff(EDIT)
    expect(file.path).toBe('C:/p/src/main.tsx')
    expect(file.status).toBe('modified')
    expect([file.added, file.removed]).toEqual([2, 1])
    const [hunk] = file.hunks
    expect(hunk.section).toBe('export function App()')
    const del = hunk.lines.find((l) => l.kind === 'del')
    expect(del).toMatchObject({ text: 'const seed = load()', oldNo: 46 })
    const adds = hunk.lines.filter((l) => l.kind === 'add')
    expect(adds.map((l) => l.newNo)).toEqual([46, 47])
    expect(hunk.lines[hunk.lines.length - 1]).toMatchObject({
      kind: 'meta',
      text: 'No newline at end of file'
    })
  })

  it("treats the tools' a/dev/null old path as a created file", () => {
    const [file] = parseUnifiedDiff(CREATE)
    expect(file).toMatchObject({ path: 'C:/p/answer.txt', status: 'added', added: 2, removed: 0 })
  })

  it('splits multi-file patches, including headers without diff --git lines', () => {
    const multi = `${EDIT}\n${CREATE}\n--- a/C:/p/old.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-gone`
    const files = parseUnifiedDiff(multi)
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['C:/p/src/main.tsx', 'modified'],
      ['C:/p/answer.txt', 'added'],
      ['C:/p/old.ts', 'deleted']
    ])
  })

  it('reads hunk bodies by count so removed "-- comment" lines are not headers', () => {
    const sql = '--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1,1 @@\n--- drop me\n keep\n'
    const [file] = parseUnifiedDiff(sql)
    expect(file.path).toBe('q.sql')
    expect(file.hunks[0].lines.map((l) => l.kind)).toEqual(['del', 'ctx'])
    expect(file.removed).toBe(1)
  })

  it('handles hunk-only and CRLF diffs, and truncated input', () => {
    expect(parseUnifiedDiff('@@ -1 +1 @@\r\n-a\r\n+b\r\n')[0]).toMatchObject({
      path: '',
      added: 1,
      removed: 1
    })
    const cut = parseUnifiedDiff(EDIT.split('\n').slice(0, 10).join('\n'))
    expect(cut[0].added).toBe(1)
    expect(parseUnifiedDiff('')).toEqual([])
  })
})

describe('formatUnifiedDiff', () => {
  it('writes diffs back out so they parse the same, including new and deleted files', () => {
    const files = parseUnifiedDiff(
      `${EDIT}\n${CREATE}\n--- a/C:/p/old.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-gone`
    )
    expect(parseUnifiedDiff(formatUnifiedDiff(files))).toEqual(files)
  })
})

/** One edit to C:/p/f.ts, from `edit`-tool hunks. */
const step = (...hunk: string[]): DiffFile =>
  parseUnifiedDiff(
    [
      'diff --git a/C:/p/f.ts b/C:/p/f.ts',
      'index 0000000..0000000 100644',
      '--- a/C:/p/f.ts',
      '+++ b/C:/p/f.ts',
      ...hunk
    ].join('\n')
  )[0]

const created = (...lines: string[]): DiffFile =>
  parseUnifiedDiff(
    [
      'diff --git a/C:/p/f.ts b/C:/p/f.ts',
      'create file mode 100644',
      'index 0000000..0000000',
      '--- a/dev/null',
      '+++ b/C:/p/f.ts',
      `@@ -1,0 +1,${lines.length} @@`,
      ...lines.map((l) => `+${l}`)
    ].join('\n')
  )[0]

/** A composed diff's hunks as text, to compare against what `diff -u` would print. */
const hunksOf = (file: DiffFile | null): string => {
  if (!file) return 'null'
  const text = formatUnifiedDiff([file])
  const at = text.indexOf('\n@@')
  return at < 0 ? '' : text.slice(at + 1)
}

describe('composeDiffs', () => {
  const lines = (n: number): string[] => Array.from({ length: n }, (_, i) => ` l${i + 1}`)

  it('returns a single edit as it is', () => {
    const only = step('@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c')
    expect(composeDiffs([only])).toBe(only)
    expect(composeDiffs([])).toBeNull()
  })

  it('keeps separate edits apart, numbering later ones against the original file', () => {
    const first = step('@@ -1,5 +1,6 @@', ' l1', '-l2', '+two', '+two-b', ' l3', ' l4', ' l5')
    // l15 is line 16 once the first edit has added a line.
    const second = step(
      '@@ -13,7 +13,7 @@',
      ...lines(18).slice(11, 14),
      '-l15',
      '+fifteen',
      ...lines(18).slice(15)
    )
    const net = composeDiffs([first, second])
    expect(net).toMatchObject({ status: 'modified', added: 3, removed: 2 })
    expect(hunksOf(net)).toBe(
      [
        '@@ -1,5 +1,6 @@',
        ' l1',
        '-l2',
        '+two',
        '+two-b',
        ' l3',
        ' l4',
        ' l5',
        '@@ -12,7 +13,7 @@',
        ' l12',
        ' l13',
        ' l14',
        '-l15',
        '+fifteen',
        ' l16',
        ' l17',
        ' l18'
      ].join('\n')
    )
  })

  it('shows only the final text of lines a later edit rewrote', () => {
    const first = step('@@ -1,7 +1,8 @@', ' a', ' b', ' c', '-d', '+D1', '+D2', ' e', ' f', ' g')
    const second = step('@@ -1,8 +1,7 @@', ' a', '-b', ' c', ' D1', '-D2', '+D2!', ' e', ' f', ' g')
    const net = composeDiffs([first, second])
    expect(net).toMatchObject({ added: 2, removed: 2 })
    expect(hunksOf(net)).toBe(
      ['@@ -1,7 +1,7 @@', ' a', '-b', ' c', '-d', '+D1', '+D2!', ' e', ' f', ' g'].join('\n')
    )
  })

  it('drops changes that a later edit undid', () => {
    const add = step('@@ -1,4 +1,5 @@', ' a', ' b', ' c', '+x', ' d')
    const undo = step('@@ -1,5 +1,4 @@', ' a', ' b', ' c', '-x', ' d')
    expect(composeDiffs([add, undo])).toMatchObject({ hunks: [], added: 0, removed: 0 })
  })

  it('shows a new file that was then edited as its final contents', () => {
    const net = composeDiffs([
      created('one', 'two', 'three'),
      step('@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three')
    ])
    expect(net).toMatchObject({ status: 'added', oldPath: null, added: 3, removed: 0 })
    expect(hunksOf(net)).toBe(['@@ -1,0 +1,3 @@', '+one', '+TWO', '+three'].join('\n'))
  })

  it('shows an edited file that was then deleted as its original contents removed', () => {
    const edit = step('@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c')
    const [gone] = parseUnifiedDiff('--- a/C:/p/f.ts\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-a\n-B\n-c')
    const net = composeDiffs([edit, gone])
    expect(net).toMatchObject({ status: 'deleted', newPath: null, added: 0, removed: 3 })
    expect(hunksOf(net)).toBe(['@@ -1,3 +1,0 @@', '-a', '-b', '-c'].join('\n'))
  })

  it('gives up when an edit doesn’t match the file the one before left', () => {
    const first = step('@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c')
    // Written as if the first edit never happened (say, a command rewrote the file between).
    const stale = step('@@ -1,3 +1,3 @@', ' a', '-b', '+beta', ' c')
    expect(composeDiffs([first, stale])).toBeNull()
    // A new file's diff shows every line, so an edit past its end can't be right.
    const beyond = step('@@ -8,3 +8,3 @@', ' x', '-y', '+Y', ' z')
    expect(composeDiffs([created('one', 'two', 'three'), beyond])).toBeNull()
  })

  it('tolerates the trailing whitespace the tools trim off a diff’s last line', () => {
    const first = step('@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c')
    const second = step('@@ -1,3 +1,3 @@', ' a', ' B', '-c  ', '+C')
    expect(hunksOf(composeDiffs([first, second]))).toBe(
      ['@@ -1,3 +1,3 @@', ' a', '-b', '+B', '-c  ', '+C'].join('\n')
    )
  })
})
