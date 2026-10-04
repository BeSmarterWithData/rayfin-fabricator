import { readFile } from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { source } from '@/lib/source';
import { siteConfig, absoluteUrl } from '@/lib/site.config';
import { lastModified } from '@/lib/last-modified';

type Page = ReturnType<typeof source.getPages>[number];

export async function getLLMText(page: Page): Promise<string> {
  const processed = rewriteRootRelative(await sourceMarkdown(page));
  const section = page.slugs[0] ?? 'docs';
  const frontmatter = [
    '---',
    `title: ${quote(page.data.title ?? 'Untitled')}`,
    `description: ${quote(page.data.description ?? '')}`,
    `url: ${absoluteUrl(page.url)}`,
    `markdown_url: ${absoluteUrl(`${page.url}.md`)}`,
    `app_version: ${quote(siteConfig.appVersion)}`,
    `section: ${section}`,
    `product: Fabricator`,
    `last_updated: ${lastModified(page.path)}`,
    `source: ${page.path}`,
    '---',
  ].join('\n');
  return `${frontmatter}\n\n# ${page.data.title}\n\n${page.data.description ? `> ${page.data.description}\n` : ''}\n${unescapeAlerts(processed.trim())}\n`;
}

async function sourceMarkdown(page: Page): Promise<string> {
  try {
    const raw = await readFile(path.join(process.cwd(), 'content', 'docs', page.path), 'utf8');
    return matter(raw).content;
  } catch {
    return page.data.getText('processed');
  }
}

function rewriteRootRelative(markdown: string): string {
  return markdown.replace(/(\]\()\/(docs|screenshots)([^)\s]*)/g, (_m, open: string, first: string, rest: string) => `${open}${absoluteUrl(`/${first}${rest}`)}`);
}

function unescapeAlerts(markdown: string): string {
  return markdown.replace(/^(\s*>\s*)\\\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/gm, '$1[!$2]');
}

function quote(value: string): string { return JSON.stringify(value); }
