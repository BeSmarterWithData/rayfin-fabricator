import { source } from '@/lib/source';
import { llms } from 'fumadocs-core/source';
import { siteConfig, absoluteUrl } from '@/lib/site.config';
import { describeSize, getBundles, renderBundle, renderFullCorpus } from '@/lib/llms-bundles';

export const dynamic = 'force-static';
export const revalidate = false;

const header = `# ${siteConfig.name}\n\n> ${siteConfig.description}\n\nThese docs cover the Fabricator desktop app: a Tauri workbench for building Rayfin apps by chatting with GitHub Copilot, previewing them live, and deploying them to Microsoft Fabric. Fabricator is not an API or SDK. For Rayfin's own SDK and CLI APIs, use https://rayfin.ai/llms.txt.\n\n## How to use these docs as an agent\n\n- Append \`.md\` to any documentation route to get that page as clean Markdown. Example: ${absoluteUrl('/docs/start/install')} -> ${absoluteUrl('/docs/start/install.md')}\n- [AGENTS.md](${absoluteUrl('/AGENTS.md')}) contains the short operating brief for agents helping someone use Fabricator.\n- Every page carries \`app_version\` and \`last_updated\` in frontmatter.\n\nDocumented for Fabricator ${siteConfig.appVersion}.\n\n`;

async function bundleIndex(): Promise<string> {
  const bundles = getBundles();
  const rendered = await Promise.all(bundles.map(async (bundle) => ({ bundle, size: describeSize(await renderBundle(bundle)) })));
  const rows = rendered.map(({ bundle, size }) => `- [${bundle.title}](${absoluteUrl(bundle.url)}): ${bundle.pages.length} page${bundle.pages.length === 1 ? '' : 's'}, ${size}`).join('\n');
  return `## Bulk downloads\n\nPrefer a section bundle over the full corpus unless you genuinely need everything.\n\n- [llms-full.txt](${absoluteUrl('/llms-full.txt')}): every page in one file, ${describeSize(await renderFullCorpus())}\n${rows ? `\n${rows}\n` : ''}\n`;
}

export async function GET() {
  const index = llms(source).index().replace(/\]\((\/docs[^)]*)\)/g, (_m, p: string) => `](${absoluteUrl(p)})`);
  return new Response(header + (await bundleIndex()) + index, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
