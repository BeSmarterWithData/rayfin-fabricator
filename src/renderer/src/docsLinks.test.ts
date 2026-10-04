import { describe, expect, it, vi } from 'vitest'
import docs from '@shared/docs-links.json'
import { docsUrl, openDocs, type DocsLink } from './docsLinks'

describe('docs links', () => {
  it('points every link at a page of the published docs site', () => {
    expect(docs.base).toBe('https://spatney.github.io/rayfin-fabricator')
    for (const link of Object.keys(docs.links) as DocsLink[]) {
      expect(docsUrl(link)).toMatch(/^https:\/\/spatney\.github\.io\/rayfin-fabricator\/docs(\/[a-z0-9-]+)*(#[a-z0-9-]+)?$/)
    }
  })

  it('opens the page in the system browser', () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)
    ;(window as unknown as { api: unknown }).api = { openExternal }
    openDocs('deployFailed')
    expect(openExternal).toHaveBeenCalledWith(
      'https://spatney.github.io/rayfin-fabricator/docs/troubleshooting/deploy#a-deploy-failed'
    )
  })
})
