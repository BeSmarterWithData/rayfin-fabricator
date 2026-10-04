import Link from 'next/link';

import { siteConfig } from '@/lib/site.config';

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-fd-background px-6 py-16 text-center text-fd-foreground">
      <div className="max-w-xl rounded-3xl border border-fd-border bg-fd-card/80 p-8 shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-fd-muted-foreground">404</p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Page not found</h1>
        <p className="mt-4 text-fd-muted-foreground">
          This Fabricator docs page may have moved. Start from the docs home or report the broken link.
        </p>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <Link
            href="/"
            className="inline-flex min-h-11 items-center justify-center rounded-lg bg-fd-primary px-5 py-2.5 text-sm font-semibold text-fd-primary-foreground transition-colors hover:bg-fd-primary/90"
          >
            Go home
          </Link>
          <Link
            href="/docs"
            className="inline-flex min-h-11 items-center justify-center rounded-lg border border-fd-border bg-fd-card px-5 py-2.5 text-sm font-semibold text-fd-foreground transition-colors hover:bg-fd-accent"
          >
            Browse docs
          </Link>
          <a
            href={`${siteConfig.repo}/issues/new/choose`}
            className="inline-flex min-h-11 items-center justify-center rounded-lg border border-fd-border bg-fd-card px-5 py-2.5 text-sm font-semibold text-fd-foreground transition-colors hover:bg-fd-accent"
          >
            Report an issue
          </a>
        </div>
      </div>
    </main>
  );
}
