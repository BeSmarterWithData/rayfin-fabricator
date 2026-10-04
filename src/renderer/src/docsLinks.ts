import docs from '@shared/docs-links.json'

/**
 * Pages of the Fabricator docs site (website/) that the app links to. The site's build
 * fails if one of these routes or anchors disappears (website/scripts/verify-app-links.mts).
 */
export type DocsLink = keyof typeof docs.links

export function docsUrl(link: DocsLink): string {
  return `${docs.base}${docs.links[link]}`
}

/** Open a docs page in the system browser. */
export function openDocs(link: DocsLink): void {
  void window.api.openExternal(docsUrl(link))
}
