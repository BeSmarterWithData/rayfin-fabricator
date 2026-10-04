import { siteConfig } from '@/lib/site.config';

export function SiteFooter({ showVersion = false }: { showVersion?: boolean }) {
  return (
    <footer className="not-prose mt-12 border-t border-fd-border pt-6 text-sm text-fd-muted-foreground">
      <p>
        Fabricator is a personal project by Sachin Patney. It is not a Microsoft product and is not affiliated with,
        endorsed by, sponsored by, or supported by Microsoft.
      </p>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
        <a className="hover:text-fd-foreground hover:underline" href={siteConfig.repo}>GitHub</a>
        <a className="hover:text-fd-foreground hover:underline" href={`${siteConfig.repo}/blob/master/LICENSE`}>MIT License</a>
        <a className="hover:text-fd-foreground hover:underline" href={siteConfig.releasesUrl}>Releases</a>
        {showVersion ? <span>Documented for Fabricator {siteConfig.appVersion}</span> : null}
      </div>
    </footer>
  );
}
