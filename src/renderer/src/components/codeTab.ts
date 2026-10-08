/**
 * Which sub-view the Code tab shows (Files, History, Skills or Secrets),
 * remembered per project. Shared so other tabs can open Code on a sub-view
 * without loading the editor bundle.
 */
export type CodeTab = 'files' | 'history' | 'skills' | 'secrets'

const codeTabKey = (projectId: string): string => `rayfin.code.tab.${projectId}`

export function readCodeTab(projectId: string): CodeTab {
  try {
    const value = localStorage.getItem(codeTabKey(projectId))
    return value === 'history' || value === 'skills' || value === 'secrets' ? value : 'files'
  } catch {
    return 'files'
  }
}

export function writeCodeTab(projectId: string, tab: CodeTab): void {
  try {
    localStorage.setItem(codeTabKey(projectId), tab)
  } catch {
    // Ignore storage failures; persistence is a convenience only.
  }
}
