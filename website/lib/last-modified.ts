import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

const CONTENT_DIR = path.join(process.cwd(), 'content', 'docs');
let cache: Map<string, string> | null = null;

function gitRoot(): string | null {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

function buildCache(): Map<string, string> {
  const map = new Map<string, string>();
  const root = gitRoot();
  const relContent = root ? path.relative(root, CONTENT_DIR).split(path.sep).join('/') : 'content/docs';
  let stdout: string;
  try {
    stdout = execFileSync('git', ['log', '--format=%x00%cI', '--name-only', '--', relContent], { cwd: root ?? process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return map; }
  let commitDate = '';
  for (const line of stdout.split('\n')) {
    if (line.startsWith('\0')) commitDate = line.slice(1).trim();
    else if (line.length > 0 && commitDate && !map.has(line.trim())) map.set(line.trim(), commitDate);
  }
  return map;
}

export function lastModified(pagePath: string): string {
  cache ??= buildCache();
  const root = gitRoot();
  const full = path.join(CONTENT_DIR, pagePath.split(path.sep).join(path.sep));
  const key = root ? path.relative(root, full).split(path.sep).join('/') : `content/docs/${pagePath.split(path.sep).join('/')}`;
  const committed = cache.get(key);
  if (committed) return committed;
  try { return statSync(full).mtime.toISOString(); } catch { return new Date().toISOString(); }
}

export function contentLastModified(): string {
  cache ??= buildCache();
  let newest = '';
  for (const date of cache.values()) if (date > newest) newest = date;
  return newest || new Date().toISOString();
}
