import { readdir, readFile, writeFile, mkdir, rm, rename, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'out');
const MIRROR_ROOT = path.join(OUT, 'llms.mdx', 'docs');
const BUNDLE_ROOT = path.join(OUT, 'llms-full');
const TERMINAL = '_md';
const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://spatney.github.io/rayfin-fabricator').replace(/\/$/, '');

const AI_CRAWLERS = ['GPTBot','OAI-SearchBot','ChatGPT-User','ClaudeBot','Claude-User','Claude-SearchBot','anthropic-ai','PerplexityBot','Perplexity-User','Google-Extended','Googlebot','Bingbot','Applebot','Applebot-Extended','Amazonbot','meta-externalagent','CCBot','cohere-ai','DuckAssistBot','MistralAI-User'];

type Emitted = { route: string; mdPath: string; title: string; description: string; lastUpdated: string };

async function main() {
  if (!existsSync(OUT)) throw new Error(`No out/ directory at ${OUT}. Run next build first.`);
  if (!existsSync(MIRROR_ROOT)) throw new Error(`No markdown mirrors at ${MIRROR_ROOT}.`);
  const emitted = (await emitMarkdownMirrors()).sort((a, b) => a.route.localeCompare(b.route));
  await rm(path.join(OUT, 'llms.mdx'), { recursive: true, force: true });
  const bundles = await nameBundleFiles();
  await writeAgentsFile(emitted, bundles);
  await writeSitemap(emitted);
  await writeRobots();
  await writeFile(path.join(OUT, '.nojekyll'), '');
  await ensure404();
  console.log(`[agent-assets] ${emitted.length} markdown mirrors emitted`);
  console.log(`[agent-assets] ${bundles.length} llms-full section bundles`);
  console.log('[agent-assets] wrote AGENTS.md, sitemap.xml, robots.txt, .nojekyll');
}

async function nameBundleFiles(): Promise<string[]> {
  if (!existsSync(BUNDLE_ROOT)) throw new Error(`No section bundles at ${BUNDLE_ROOT}.`);
  const named: string[] = [];
  for (const entry of await readdir(BUNDLE_ROOT, { withFileTypes: true })) {
    if (!entry.isFile() || path.extname(entry.name)) continue;
    await rename(path.join(BUNDLE_ROOT, entry.name), path.join(BUNDLE_ROOT, `${entry.name}.txt`));
    named.push(`/llms-full/${entry.name}.txt`);
  }
  return named.sort();
}

async function emitMarkdownMirrors(): Promise<Emitted[]> {
  const emitted: Emitted[] = [];
  async function walk(dir: string, segments: string[]) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, [...segments, entry.name]);
      else if (entry.isFile() && entry.name === TERMINAL) emitted.push(await copyMirror(full, ['docs', ...segments]));
    }
  }
  await walk(MIRROR_ROOT, []);
  return emitted;
}

async function copyMirror(source: string, segments: string[]): Promise<Emitted> {
  const body = await readFile(source, 'utf8');
  const route = `/${segments.join('/')}`;
  const target = path.join(OUT, ...segments) + '.md';
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, body, 'utf8');
  return { route, mdPath: `${route}.md`, title: frontmatterValue(body, 'title') || route, description: frontmatterValue(body, 'description'), lastUpdated: frontmatterValue(body, 'last_updated') };
}

function frontmatterValue(body: string, key: string): string {
  const match = body.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  if (!match) return '';
  const raw = match[1].trim();
  try { return raw.startsWith('"') ? JSON.parse(raw) as string : raw; } catch { return raw; }
}

async function writeAgentsFile(pages: Emitted[], bundles: string[]) {
  const brief = await readFile(path.join(ROOT, 'lib', 'agent-brief.md'), 'utf8');
  const content = `${brief.trim()}\n\n## Machine-readable entry points\n\n- [llms.txt](${SITE_URL}/llms.txt) — index of every page with descriptions and bulk download sizes.\n- [llms-full.txt](${SITE_URL}/llms-full.txt) — complete corpus.\n${bundles.map((b) => `- [${b}](${SITE_URL}${b}) — section bundle.`).join('\n')}\n\n## All pages\n\n${pages.map((p) => `- [${p.title}](${SITE_URL}${p.mdPath})${p.description ? `: ${p.description}` : ''}`).join('\n')}\n`;
  await writeFile(path.join(OUT, 'AGENTS.md'), content, 'utf8');
}

async function writeSitemap(pages: Emitted[]) {
  const newest = pages.reduce((acc, p) => (p.lastUpdated > acc ? p.lastUpdated : acc), '');
  const entries = [{ loc: '/', lastmod: newest }, ...pages.map((p) => ({ loc: p.route, lastmod: p.lastUpdated })), { loc: '/llms.txt', lastmod: newest }, { loc: '/AGENTS.md', lastmod: newest }];
  const body = entries.map(({ loc, lastmod }) => `  <url>\n    <loc>${SITE_URL}${loc}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ''}\n  </url>`).join('\n');
  await writeFile(path.join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`, 'utf8');
}

async function writeRobots() {
  const content = `# Fabricator documentation\n# Agents and crawlers are welcome. Markdown mirrors live at <any-route>.md\n\nUser-agent: *\nAllow: /\n\n${AI_CRAWLERS.map((ua) => `User-agent: ${ua}`).join('\n')}\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n\n# Machine-readable entry points\n# ${SITE_URL}/llms.txt\n# ${SITE_URL}/llms-full.txt\n# ${SITE_URL}/AGENTS.md\n`;
  await writeFile(path.join(OUT, 'robots.txt'), content, 'utf8');
}

async function ensure404() {
  const target = path.join(OUT, '404.html');
  if (existsSync(target)) return;
  if (existsSync(path.join(OUT, '_not-found.html'))) await copyFile(path.join(OUT, '_not-found.html'), target);
  else await writeFile(target, '<!doctype html><html><head><meta charset="utf-8"><title>404</title></head><body><h1>404</h1><p>Page not found.</p></body></html>\n', 'utf8');
}

await main();
