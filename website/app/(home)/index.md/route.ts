import { siteConfig } from '@/lib/site.config';

export const dynamic = 'force-static';
export const revalidate = false;

export function GET() {
  return new Response(
    [
      `# ${siteConfig.name}`,
      '',
      siteConfig.description,
      '',
      `- Install: ${siteConfig.baseUrl}/docs/start/install`,
      `- Documentation: ${siteConfig.baseUrl}/docs`,
      `- Docs index for agents: ${siteConfig.baseUrl}/llms.txt`,
      `- Releases: ${siteConfig.releasesUrl}`,
      `- Source: ${siteConfig.repo}`,
      '',
    ].join('\n'),
    { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } },
  );
}
