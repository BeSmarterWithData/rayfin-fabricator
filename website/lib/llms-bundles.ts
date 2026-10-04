import { readFileSync } from 'node:fs';
import path from 'node:path';
import { source } from '@/lib/source';
import { getLLMText } from '@/lib/get-llm-text';
import { siteConfig, absoluteUrl } from '@/lib/site.config';

const CONTENT_DIR = path.join(process.cwd(), 'content', 'docs');
type Page = ReturnType<typeof source.getPages>[number];
export type Bundle = { section: string; title: string; url: string; pages: Page[] };

function sectionOf(page: Page): string { return page.slugs[0] ?? 'docs'; }

export function getBundles(): Bundle[] {
  const pages = source.getPages();
  const grouped = new Map<string, Page[]>();
  for (const page of pages) (grouped.get(sectionOf(page)) ?? grouped.set(sectionOf(page), []).get(sectionOf(page))!).push(page);
  const ordered = ['docs', 'start', 'build', 'ship', 'team', 'troubleshooting', 'reference'].filter((s) => grouped.has(s));
  for (const section of [...grouped.keys()].sort()) if (!ordered.includes(section)) ordered.push(section);
  return ordered.map((section) => ({ section, title: titleOf(section), url: `/llms-full/${section}.txt`, pages: grouped.get(section) ?? [] }));
}

function titleOf(section: string): string {
  if (section === 'docs') return 'Overview';
  return readMeta(section).title ?? source.getPage([section])?.data.title ?? section.charAt(0).toUpperCase() + section.slice(1);
}

function readMeta(...segments: string[]): { title?: string; pages?: string[] } {
  try { return JSON.parse(readFileSync(path.join(CONTENT_DIR, ...segments, 'meta.json'), 'utf8')) as { title?: string; pages?: string[] }; }
  catch { return {}; }
}

export async function renderBundle(bundle: Bundle): Promise<string> {
  return render(bundle.pages, `${siteConfig.name} documentation — ${bundle.title} section.`, absoluteUrl(bundle.url));
}
export async function renderFullCorpus(): Promise<string> {
  return render(source.getPages(), `${siteConfig.name} documentation — complete corpus.`, absoluteUrl('/llms-full.txt'));
}
async function render(pages: Page[], summary: string, self: string): Promise<string> {
  const bodies = await Promise.all(pages.map(getLLMText));
  return `<!--\n${summary}\nGenerated from ${absoluteUrl('/docs')} — this file is ${self}.\nDocuments Fabricator ${siteConfig.appVersion}. For Rayfin SDK and CLI APIs, use https://rayfin.ai/llms.txt.\n${pages.length} page${pages.length === 1 ? '' : 's'}.\n-->\n\n${bodies.join('\n\n---\n\n')}`;
}
export function describeSize(text: string): string {
  const bytes = Buffer.byteLength(text, 'utf8');
  const kb = (bytes / 1024).toFixed(1);
  const tokens = Math.round(text.length / 4);
  return `${kb} KB (~${tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : tokens} tokens)`;
}
