import type { DiffEditorProps } from '@monaco-editor/react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitChange, GitFileDiff, GitHistory, RayfinStudioApi } from '@shared/ipc'
import { makeProject } from '../../test/harness'
import HistoryView from './HistoryView'

const editorProps = vi.hoisted(() => vi.fn<(props: DiffEditorProps) => void>())
vi.mock('../monaco', () => ({ monacoLanguage: () => 'json' }))
vi.mock('@monaco-editor/react', () => ({
  DiffEditor: (props: DiffEditorProps) => {
    editorProps(props)
    return (
      <div data-testid="diff-editor">
        <output data-testid="original">{props.original}</output>
        <output data-testid="modified">{props.modified}</output>
      </div>
    )
  }
}))

const before = '{\n  "name": "meow"\n}\n'
const after = '{\n  "name": "meow",\n  "private": true\n}\n'
const change: GitChange = {
  path: 'package.json',
  status: 'modified',
  insertions: 2,
  deletions: 1
}
const history: GitHistory = {
  isRepo: true,
  workingChanges: 1,
  head: 'abc123',
  commits: [
    {
      hash: 'abc123',
      shortHash: 'abc123',
      subject: 'Create app',
      author: 'Test',
      relativeDate: '1 minute ago',
      isoDate: '2026-10-04T06:00:00Z',
      filesChanged: 1,
      insertions: 3,
      deletions: 0
    }
  ]
}

function installApi(overrides: Partial<GitFileDiff> = {}) {
  const git = {
    log: vi.fn<RayfinStudioApi['projects']['git']['log']>().mockResolvedValue(history),
    changes: vi.fn<RayfinStudioApi['projects']['git']['changes']>().mockResolvedValue([change]),
    fileDiff: vi.fn<RayfinStudioApi['projects']['git']['fileDiff']>().mockResolvedValue({
      path: change.path,
      status: change.status,
      before,
      after,
      ...overrides
    }),
    fileLog: vi
      .fn<RayfinStudioApi['projects']['git']['fileLog']>()
      .mockResolvedValue(history.commits)
  }
  vi.stubGlobal('api', { projects: { git } })
  return git
}

function mount(): void {
  const project = {
    ...makeProject('p1'),
    path: 'C:\\team\\working copy\\apps\\meow',
    team: { workspaceId: 'w1', folder: 'meow', worktree: 'C:\\team\\working copy' }
  }
  render(<HistoryView project={project} refreshKey={0} theme="vs-dark" />)
}

beforeEach(() => editorProps.mockClear())
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('HistoryView uncommitted diffs', () => {
  it('passes the complete working content to both diff layouts using app-relative paths', async () => {
    const git = installApi()
    mount()
    expect((await screen.findByTestId('original')).textContent).toBe(before)
    expect(screen.getByTestId('modified').textContent).toBe(after)
    expect(git.fileDiff).toHaveBeenCalledWith('p1', 'WORKING', 'package.json', undefined)
    expect(editorProps.mock.lastCall?.[0].options?.renderSideBySide).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Side by side' }))
    expect(editorProps.mock.lastCall?.[0].options?.renderSideBySide).toBe(true)
    expect(screen.getByTestId('modified').textContent).toBe(after)
    fireEvent.click(screen.getByTitle('See every change to this file'))
    await waitFor(() => expect(git.fileLog).toHaveBeenCalledWith('p1', 'package.json'))
  })

  it('keeps a genuinely deleted file as an empty modified side', async () => {
    installApi({ status: 'deleted', after: '' })
    mount()
    expect((await screen.findByTestId('original')).textContent).toBe(before)
    expect(screen.getByTestId('modified').textContent).toBe('')
  })

  it('shows read errors instead of a misleading deletion or a copy action', async () => {
    installApi({ before: '', after: '', error: 'Could not read package.json: Access is denied.' })
    mount()
    expect(await screen.findByText('Could not read package.json: Access is denied.')).toBeTruthy()
    expect(screen.queryByTestId('diff-editor')).toBeNull()
    expect(screen.queryByTitle("Copy this version's contents")).toBeNull()
  })

  it('recognizes binary working files even when the change list has no binary flag', async () => {
    installApi({ before: '', after: '', binary: true })
    mount()
    expect(await screen.findByText(/This is an image or binary file/)).toBeTruthy()
    expect(screen.queryByTestId('diff-editor')).toBeNull()
  })
})
