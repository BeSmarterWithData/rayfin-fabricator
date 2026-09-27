// Unified diffs for the chat's inline diff viewer: parsing the shapes the
// Copilot tools emit (`diff --git a/C:/… b/C:/…` headers, `--- a/dev/null` for
// created files, multi-file `apply_patch` diffs, and hunk-only diffs),
// combining one file's successive edits into a single diff, and writing diffs
// back out as text.

export type DiffLineKind = 'add' | 'del' | 'ctx' | 'meta'

export interface DiffLine {
  kind: DiffLineKind
  text: string
  oldNo?: number
  newNo?: number
}

export interface DiffHunk {
  oldStart: number
  newStart: number
  /** Trailing context after the `@@ … @@` marker (often a function name). */
  section: string
  lines: DiffLine[]
}

export type DiffFileStatus = 'added' | 'deleted' | 'modified' | 'renamed'

export interface DiffFile {
  /** The path shown for the file (new path, or old path for deletions). */
  path: string
  oldPath: string | null
  newPath: string | null
  status: DiffFileStatus
  hunks: DiffHunk[]
  added: number
  removed: number
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/

/** `a/src/x.ts` → `src/x.ts`; `/dev/null` (or the tools' `a/dev/null`) → null. */
function headerPath(raw: string): string | null {
  const p = raw.replace(/\t.*$/, '').trim()
  const stripped = /^[ab]\//.test(p) ? p.slice(2) : p
  return stripped === '/dev/null' || stripped === 'dev/null' ? null : stripped
}

/**
 * Parse a unified diff into files and hunks. Hunk bodies are read using the
 * line counts from their `@@` header, so content such as a removed `-- comment`
 * line (`--- comment`) is never mistaken for a file header.
 */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0
  let oldLeft = 0
  let newLeft = 0

  const startFile = (): DiffFile => {
    const f: DiffFile = {
      path: '',
      oldPath: null,
      newPath: null,
      status: 'modified',
      hunks: [],
      added: 0,
      removed: 0
    }
    files.push(f)
    return f
  }

  for (const line of diff.replace(/\r\n?/g, '\n').split('\n')) {
    const open: boolean = hunk !== null && (oldLeft > 0 || newLeft > 0)
    if (open && file && hunk) {
      const h: DiffHunk = hunk
      const first = line[0]
      if (first === '+') {
        h.lines.push({ kind: 'add', text: line.slice(1), newNo: newNo++ })
        file.added++
        newLeft--
        continue
      }
      if (first === '-') {
        h.lines.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ })
        file.removed++
        oldLeft--
        continue
      }
      if (first === ' ' || line === '') {
        h.lines.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
        oldLeft--
        newLeft--
        continue
      }
      if (first === '\\') {
        h.lines.push({ kind: 'meta', text: line.slice(1).trim() })
        continue
      }
    }
    if (line.startsWith('\\') && hunk) {
      // "\ No newline at end of file" trails the hunk it belongs to.
      ;(hunk as DiffHunk).lines.push({ kind: 'meta', text: line.slice(1).trim() })
      continue
    }
    const m = HUNK_RE.exec(line)
    if (m) {
      if (!file) file = startFile()
      oldNo = Number(m[1])
      newNo = Number(m[3])
      oldLeft = m[2] === undefined ? 1 : Number(m[2])
      newLeft = m[4] === undefined ? 1 : Number(m[4])
      hunk = { oldStart: oldNo, newStart: newNo, section: m[5].trim(), lines: [] }
      file.hunks.push(hunk)
      continue
    }
    if (line.startsWith('diff --git ')) {
      file = startFile()
      hunk = null
      continue
    }
    if (line.startsWith('--- ')) {
      // A `---` header after hunks starts a new file that had no `diff --git` line.
      if (!file || file.hunks.length) file = startFile()
      hunk = null
      file.oldPath = headerPath(line.slice(4))
      continue
    }
    if (!file || file.hunks.length) continue
    if (line.startsWith('+++ ')) file.newPath = headerPath(line.slice(4))
    else if (line.startsWith('new file mode')) file.status = 'added'
    else if (line.startsWith('deleted file mode')) file.status = 'deleted'
    else if (line.startsWith('rename from ')) {
      file.status = 'renamed'
      file.oldPath = line.slice('rename from '.length).trim()
    } else if (line.startsWith('rename to ')) file.newPath = line.slice('rename to '.length).trim()
  }

  for (const f of files) {
    if (f.status === 'modified') {
      if (f.oldPath == null && f.newPath != null) f.status = 'added'
      else if (f.newPath == null && f.oldPath != null) f.status = 'deleted'
    }
    f.path = f.newPath ?? f.oldPath ?? ''
  }
  return files.filter((f) => f.hunks.length > 0 || f.path)
}

/** Unchanged lines kept around each change in a combined diff. */
const CONTEXT = 3

/**
 * Where a hunk side starts, as a 1-based line position. The Copilot tools
 * number an empty side by where its lines would go (`@@ -1,0 +1,3 @@` creates
 * a file) and write a deleted file's new side as `+0,0`.
 */
const sideStart = (start: number): number => Math.max(1, start)

function pushAt(map: Map<number, string[]>, at: number, text: string): void {
  const list = map.get(at)
  if (list) list.push(text)
  else map.set(at, [text])
}

/**
 * The text two diffs show for the same line, or null when they disagree. The
 * tools trim trailing whitespace off the end of a diff, so that alone is not a
 * disagreement.
 */
function sameLine(a: string, b: string): string | null {
  if (a === b) return a
  if (a.trimEnd() !== b.trimEnd()) return null
  return a.length >= b.length ? a : b
}

/**
 * Compose `first` (A→B) with `next` (B→C) into A→C. Both are read on B, the
 * version between them: `first`'s new side and `next`'s old side. A line
 * neither shows was unchanged by both. `whole` says `first` shows every line of
 * B. Returns hunks with all the context either diff showed, or null when the
 * two disagree about B — e.g. when something other than these edits changed
 * the file in between.
 */
function composePair(
  first: readonly DiffHunk[],
  whole: boolean,
  next: DiffFile
): DiffHunk[] | null {
  // B's lines as `first` shows them (`fromA` is false for lines it added), and
  // the A lines it removed, filed under the B line they preceded.
  const mid = new Map<number, { text: string; fromA: boolean }>()
  const removed = new Map<number, string[]>()
  let end = 0
  for (const h of first) {
    let at = sideStart(h.newStart)
    if (at < end) return null
    for (const l of h.lines) {
      if (l.kind === 'del') pushAt(removed, at, l.text)
      else if (l.kind !== 'meta') mid.set(at++, { text: l.text, fromA: l.kind === 'ctx' })
    }
    end = at
  }
  // B's lines as `next` shows them (`kept` is false for lines it removed), and
  // the C lines it added, filed under the B line they precede.
  const seen = new Map<number, { text: string; kept: boolean }>()
  const added = new Map<number, string[]>()
  end = 0
  for (const h of next.hunks) {
    let at = sideStart(h.oldStart)
    if (at < end) return null
    for (const l of h.lines) {
      if (l.kind === 'add') pushAt(added, at, l.text)
      else if (l.kind !== 'meta') {
        const known = mid.get(at)
        const text = known ? sameLine(known.text, l.text) : l.text
        if (text == null) return null
        seen.set(at++, { text, kept: l.kind === 'ctx' })
      }
    }
    end = at
  }
  // A file is only created where there is none, and deleting one removes every
  // line; when `first` shows all of B, `next` can't touch lines past its end.
  if (next.status === 'added' && mid.size > 0) return null
  if (next.status === 'deleted' && [...mid.keys()].some((at) => !seen.has(at))) return null
  if (
    whole &&
    ([...seen.keys()].some((at) => !mid.has(at)) ||
      [...added.keys()].some((at) => at > mid.size + 1))
  )
    return null

  const positions = [
    ...new Set([...mid.keys(), ...seen.keys(), ...removed.keys(), ...added.keys()])
  ].sort((x, y) => x - y)
  const hunks: DiffHunk[] = []
  let hunk: DiffHunk | null = null
  let oldNo = 0 // A lines so far
  let newNo = 0 // C lines so far
  let passed = 0 // B lines so far
  for (const at of positions) {
    // B lines neither diff shows are the same in A, B and C.
    const hidden = at - 1 - passed
    if (!hunk || hidden > 0) {
      oldNo += hidden
      newNo += hidden
      hunk = { oldStart: oldNo + 1, newStart: newNo + 1, section: '', lines: [] }
      hunks.push(hunk)
    }
    passed = at - 1
    for (const text of removed.get(at) ?? []) hunk.lines.push({ kind: 'del', text, oldNo: ++oldNo })
    for (const text of added.get(at) ?? []) hunk.lines.push({ kind: 'add', text, newNo: ++newNo })
    const before = mid.get(at)
    const after = seen.get(at)
    const line = after ?? before
    if (!line) continue
    passed = at
    const fromA = before?.fromA ?? true
    const kept = after?.kept ?? true
    if (fromA && kept)
      hunk.lines.push({ kind: 'ctx', text: line.text, oldNo: ++oldNo, newNo: ++newNo })
    else if (fromA) hunk.lines.push({ kind: 'del', text: line.text, oldNo: ++oldNo })
    else if (kept) hunk.lines.push({ kind: 'add', text: line.text, newNo: ++newNo })
  }
  return hunks
}

/** Keep `context` unchanged lines around changes, splitting hunks where more lie between. */
function trimContext(hunks: readonly DiffHunk[], context = CONTEXT): DiffHunk[] {
  const out: DiffHunk[] = []
  for (const h of hunks) {
    // The line numbers at each line, so any line can start a hunk.
    const starts: [number, number][] = []
    const changes: number[] = []
    let oldNo = h.oldStart
    let newNo = h.newStart
    h.lines.forEach((l, i) => {
      starts.push([oldNo, newNo])
      if (l.kind === 'add' || l.kind === 'del') changes.push(i)
      if (l.kind === 'ctx' || l.kind === 'del') oldNo++
      if (l.kind === 'ctx' || l.kind === 'add') newNo++
    })
    let i = 0
    while (i < changes.length) {
      let j = i
      while (j + 1 < changes.length && changes[j + 1] - changes[j] - 1 <= 2 * context) j++
      const from = Math.max(0, changes[i] - context)
      const to = Math.min(h.lines.length, changes[j] + context + 1)
      const [oldStart, newStart] = starts[from]
      out.push({ oldStart, newStart, section: '', lines: h.lines.slice(from, to) })
      i = j + 1
    }
  }
  return out
}

/**
 * Combine one file's diffs, made one after another (each against the file the
 * one before left), into the single diff from before the first to after the
 * last. Returns null when they don't line up, such as when something other
 * than these edits changed the file between them.
 */
export function composeDiffs(steps: readonly DiffFile[]): DiffFile | null {
  const [head, ...rest] = steps
  if (!head) return null
  if (rest.length === 0) return head
  let hunks: DiffHunk[] = head.hunks
  // True once `hunks` shows every line of the file, as a new file's diff does.
  let whole = head.status === 'added'
  for (const step of rest) {
    const next = composePair(hunks, whole, step)
    if (!next) return null
    hunks = next
    whole = whole || step.status === 'added' || step.status === 'deleted'
  }
  hunks = trimContext(hunks)
  const last = rest[rest.length - 1]
  const { oldPath } = head
  const { newPath } = last
  const count = (kind: DiffLineKind): number =>
    hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === kind).length, 0)
  return {
    path: newPath ?? oldPath ?? last.path,
    oldPath,
    newPath,
    status: !oldPath
      ? 'added'
      : !newPath
        ? 'deleted'
        : oldPath !== newPath
          ? 'renamed'
          : 'modified',
    hunks,
    added: count('add'),
    removed: count('del')
  }
}

const SIGN: Record<DiffLineKind, string> = { add: '+', del: '-', ctx: ' ', meta: '\\ ' }

/** Write diff files back out as unified diff text, the way `parseUnifiedDiff` reads it. */
export function formatUnifiedDiff(files: readonly DiffFile[]): string {
  const out: string[] = []
  for (const f of files) {
    const oldPath = f.status === 'added' ? null : (f.oldPath ?? f.path)
    const newPath = f.status === 'deleted' ? null : (f.newPath ?? f.path)
    out.push(`diff --git a/${oldPath ?? newPath} b/${newPath ?? oldPath}`)
    if (f.status === 'renamed') out.push(`rename from ${oldPath}`, `rename to ${newPath}`)
    out.push(oldPath ? `--- a/${oldPath}` : '--- /dev/null')
    out.push(newPath ? `+++ b/${newPath}` : '+++ /dev/null')
    for (const h of f.hunks) {
      const oldCount = h.lines.filter((l) => l.kind === 'ctx' || l.kind === 'del').length
      const newCount = h.lines.filter((l) => l.kind === 'ctx' || l.kind === 'add').length
      const section = h.section ? ` ${h.section}` : ''
      out.push(`@@ -${h.oldStart},${oldCount} +${h.newStart},${newCount} @@${section}`)
      for (const l of h.lines) out.push(SIGN[l.kind] + l.text)
    }
  }
  return out.join('\n')
}
