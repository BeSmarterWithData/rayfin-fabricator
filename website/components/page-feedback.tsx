import { absoluteUrl, siteConfig } from '@/lib/site.config';

const { owner, name, branch, contentDir } = siteConfig.github;

export function PageFeedback({ title, url, path }: { title: string; url: string; path: string }) {
  const source = `${contentDir}/${path}`;
  const issueUrl = new URL(`https://github.com/${owner}/${name}/issues/new`);
  issueUrl.searchParams.set('title', `[Docs] ${title}`);
  issueUrl.searchParams.set('body', [`Page: ${absoluteUrl(url)}`, '', 'What is wrong or missing?', ''].join('\n'));
  const editUrl = `https://github.com/${owner}/${name}/edit/${branch}/${source}`;

  return (
    <div className="not-prose mt-12 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-fd-border pt-6 text-sm">
      <span className="text-fd-muted-foreground">Something wrong on this page?</span>
      <a href={editUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-fd-primary hover:underline">
        Edit this page
      </a>
      <span aria-hidden className="text-fd-muted-foreground/50">·</span>
      <a href={issueUrl.toString()} target="_blank" rel="noopener noreferrer" className="font-medium text-fd-muted-foreground hover:text-fd-foreground hover:underline">
        Report an issue with this page
      </a>
    </div>
  );
}
