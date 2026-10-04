/**
 * Fails the build when a docs page or heading that the Fabricator app links to is
 * missing from the static export. The app's links live in src/shared/docs-links.json
 * (see src/renderer/src/docsLinks.ts); renaming a page or a linked heading must update
 * that file in the same change.
 *
 * Run after `npm run build`.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { siteConfig } from '../lib/site.config';

const WEBSITE = path.resolve(import.meta.dirname, '..');
const OUT = path.join(WEBSITE, 'out');
const LINKS_FILE = path.resolve(WEBSITE, '..', 'src', 'shared', 'docs-links.json');

const { base, links } = JSON.parse(readFileSync(LINKS_FILE, 'utf8')) as {
  base: string;
  links: Record<string, string>;
};

const errors: string[] = [];

if (base !== siteConfig.baseUrl) {
  errors.push(`docs-links.json base ${base} does not match the site URL ${siteConfig.baseUrl}`);
}

for (const [name, target] of Object.entries(links)) {
  const [route, anchor] = target.split('#');
  if (!route.startsWith('/docs')) {
    errors.push(`${name}: ${target} is not a docs route`);
    continue;
  }
  const candidates = [path.join(OUT, `${route}.html`), path.join(OUT, route, 'index.html')];
  const file = candidates.find((candidate) => existsSync(candidate));
  if (!file) {
    errors.push(`${name}: no page for ${route}`);
    continue;
  }
  if (anchor && !readFileSync(file, 'utf8').includes(`id="${anchor}"`)) {
    errors.push(`${name}: ${route} has no heading with id "${anchor}"`);
  }
}

if (errors.length) {
  console.error(`In-app docs links are broken (${LINKS_FILE}):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(`verify-app-links: ${Object.keys(links).length} in-app links resolve.`);
