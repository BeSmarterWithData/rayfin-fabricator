import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'out');
const REQUIRED_FRONTMATTER = ['title','description','url','markdown_url','app_version','last_updated'];
const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://spatney.github.io/rayfin-fabricator').replace(/\/$/, '');
const errors: string[] = [];

async function main() {
  if (!existsSync(OUT)) throw new Error('No out/ directory. Run npm run build first.');
  const htmlRoutes = await collectDocsHtmlRoutes();
  if (htmlRoutes.length === 0) errors.push('no rendered docs pages found in out/');
  await checkMirrors(htmlRoutes);
  await checkRootAssets();
  await checkBundles();
  await checkLlmsCoverage(htmlRoutes);
  await checkSitemap(htmlRoutes);
  if (errors.length > 0) { for (const e of errors) console.error(`error  ${e}`); console.error(`\n[verify-agent] FAILED with ${errors.length} error(s)`); process.exitCode = 1; return; }
  console.log(`[verify-agent] ${htmlRoutes.length} docs pages, all mirrors valid`);
  console.log('[verify-agent] llms.txt, llms-full.txt, section bundles, AGENTS.md, sitemap.xml, robots.txt, .nojekyll present');
}

async function collectDocsHtmlRoutes(): Promise<string[]> {
  const routes: string[] = [];
  if (existsSync(path.join(OUT, 'docs.html'))) routes.push('/docs');
  async function walk(dir: string, segments: string[]) {
    if (!existsSync(dir)) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, [...segments, entry.name]);
      else if (entry.name.endsWith('.html') && entry.name !== 'index.html') routes.push(`/docs/${[...segments, entry.name.replace(/\.html$/, '')].join('/')}`);
    }
  }
  await walk(path.join(OUT, 'docs'), []);
  return routes.sort();
}

async function checkMirrors(routes: string[]) {
  for (const route of routes) {
    const mirror = path.join(OUT, `${route.replace(/^\//, '')}.md`);
    if (!existsSync(mirror)) { errors.push(`${route} has no markdown mirror at ${route}.md`); continue; }
    const body = await readFile(mirror, 'utf8');
    if (!body.startsWith('---\n')) { errors.push(`${route}.md does not start with YAML frontmatter`); continue; }
    const end = body.indexOf('\n---', 4);
    if (end === -1) { errors.push(`${route}.md has an unterminated frontmatter block`); continue; }
    const fm = body.slice(4, end);
    for (const key of REQUIRED_FRONTMATTER) if (!new RegExp(`^${key}:`, 'm').test(fm)) errors.push(`${route}.md frontmatter is missing ${key}`);
    if (/^description:\s*""\s*$/m.test(fm)) errors.push(`${route}.md has an empty description`);
    const stamp = fm.match(/^last_updated:\s*(.+)$/m)?.[1]?.trim();
    if (stamp && Number.isNaN(Date.parse(stamp))) errors.push(`${route}.md has an unparseable last_updated: ${stamp}`);
  }
}

async function checkRootAssets() {
  for (const name of ['llms.txt','llms-full.txt','AGENTS.md','sitemap.xml','robots.txt','.nojekyll','404.html']) {
    const file = path.join(OUT, name);
    if (!existsSync(file)) { errors.push(`missing ${name} in out/`); continue; }
    const { size } = await stat(file);
    if (name !== '.nojekyll' && size === 0) errors.push(`${name} is empty`);
  }
  if (existsSync(path.join(OUT, 'llms.mdx'))) errors.push('out/llms.mdx was not cleaned up');
  if (existsSync(path.join(OUT, 'staticwebapp.config.json'))) errors.push('staticwebapp.config.json should not be emitted for GitHub Pages');
  if (existsSync(path.join(OUT, '_headers'))) errors.push('_headers should not be emitted for GitHub Pages');
}

async function checkBundles() {
  const dir = path.join(OUT, 'llms-full');
  if (!existsSync(dir)) { errors.push('missing out/llms-full section bundles'); return; }
  const entries = await readdir(dir, { withFileTypes: true });
  const bundles = new Set(entries.filter((e) => e.isFile() && e.name.endsWith('.txt')).map((e) => e.name));
  for (const section of ['docs','start','build','ship','team','troubleshooting','reference']) if (!bundles.has(`${section}.txt`)) errors.push(`no bulk download for section ${section}`);
}

async function checkLlmsCoverage(routes: string[]) {
  const file = path.join(OUT, 'llms.txt');
  if (!existsSync(file)) return;
  const body = await readFile(file, 'utf8');
  for (const route of routes) if (!body.includes(`(${SITE_URL}${route})`) && !body.includes(`(${route})`)) errors.push(`llms.txt does not list ${route}`);
  if (!body.includes('## Bulk downloads')) errors.push('llms.txt does not advertise bulk downloads');
}

async function checkSitemap(routes: string[]) {
  const file = path.join(OUT, 'sitemap.xml');
  if (!existsSync(file)) return;
  const body = await readFile(file, 'utf8');
  const locs = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  for (const loc of locs) { if (!loc.startsWith(SITE_URL)) errors.push(`sitemap ${loc} does not start with ${SITE_URL}`); if (loc !== `${SITE_URL}/` && loc.endsWith('/')) errors.push(`sitemap ${loc} has trailing slash`); if (loc.endsWith('.md') && loc !== `${SITE_URL}/AGENTS.md`) errors.push(`sitemap lists markdown mirror ${loc}`); }
  const listed = new Set(locs);
  for (const route of routes) if (!listed.has(`${SITE_URL}${route}`)) errors.push(`sitemap does not list ${route}`);
  if (![...body.matchAll(/<url>[\s\S]*?<\/url>/g)].every((u) => u[0].includes('<lastmod>'))) errors.push('some sitemap entries have no lastmod');
}

await main();
