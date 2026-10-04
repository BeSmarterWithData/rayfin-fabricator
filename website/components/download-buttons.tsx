'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
};

type ReleaseResponse = {
  tag_name?: string;
  name?: string;
  assets?: ReleaseAsset[];
};

type Platform = 'windows' | 'mac' | 'other';

type Download = {
  platform: Exclude<Platform, 'other'>;
  label: string;
  href: string;
};

type NavigatorWithUAData = Navigator & {
  userAgentData?: { platform?: string };
};

function detectPlatform(): Platform {
  const nav = navigator as NavigatorWithUAData;
  const platform = (nav.userAgentData?.platform ?? navigator.platform ?? navigator.userAgent).toLowerCase();
  const ua = navigator.userAgent.toLowerCase();

  if (platform.includes('win') || ua.includes('windows')) return 'windows';
  if (platform.includes('mac') || ua.includes('macintosh')) return 'mac';
  return 'other';
}

function findAsset(release: ReleaseResponse, suffix: string): string | undefined {
  return release.assets?.find((asset) => asset.name.endsWith(suffix))?.browser_download_url;
}

export function DownloadButtons({ releasesUrl }: { releasesUrl: string }) {
  const [platform, setPlatform] = useState<Platform>('other');
  const [version, setVersion] = useState<string>('Latest release');
  const [downloads, setDownloads] = useState<Download[]>([
    { platform: 'windows', label: 'Download for Windows', href: releasesUrl },
    { platform: 'mac', label: 'Download for macOS', href: releasesUrl },
  ]);

  useEffect(() => {
    setPlatform(detectPlatform());

    const controller = new AbortController();
    fetch('https://api.github.com/repos/spatney/rayfin-fabricator/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error(`GitHub release request failed: ${response.status}`);
        return response.json() as Promise<ReleaseResponse>;
      })
      .then((release) => {
        const windows = findAsset(release, '_x64-setup.exe') ?? releasesUrl;
        const mac = findAsset(release, '_aarch64.dmg') ?? releasesUrl;
        setVersion(release.tag_name || release.name || 'Latest release');
        setDownloads([
          { platform: 'windows', label: 'Download for Windows', href: windows },
          { platform: 'mac', label: 'Download for macOS', href: mac },
        ]);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
      });

    return () => controller.abort();
  }, [releasesUrl]);

  const ordered = useMemo(() => {
    if (platform === 'other') return downloads;
    return [...downloads].sort((a, b) => (a.platform === platform ? -1 : b.platform === platform ? 1 : 0));
  }, [downloads, platform]);

  return (
    <div className="flex w-full flex-col items-center gap-3">
      <div className="flex w-full max-w-xl flex-col justify-center gap-3 sm:w-auto sm:max-w-none sm:flex-row">
        {ordered.map((download) => {
          const primary = download.platform === platform || (platform === 'other' && download.platform === 'windows');
          return (
            <a
              key={download.platform}
              href={download.href}
              className={
                primary
                  ? 'inline-flex min-h-11 items-center justify-center rounded-lg bg-fd-primary px-5 py-2.5 text-sm font-semibold text-fd-primary-foreground shadow-sm transition-opacity hover:opacity-90'
                  : 'inline-flex min-h-11 items-center justify-center rounded-lg border border-fd-border bg-fd-card/70 px-5 py-2.5 text-sm font-semibold text-fd-foreground backdrop-blur transition-colors hover:bg-fd-accent'
              }
            >
              {download.label}
            </a>
          );
        })}
        <Link
          href="/docs"
          className="inline-flex min-h-11 items-center justify-center rounded-lg border border-fd-border bg-fd-card/70 px-5 py-2.5 text-sm font-semibold text-fd-foreground backdrop-blur transition-colors hover:bg-fd-accent"
        >
          Read the docs
        </Link>
      </div>
      <p className="text-center text-xs text-fd-muted-foreground sm:text-sm">
        {version} · Windows 10/11 · macOS on Apple Silicon
      </p>
      <Link href="/docs/start/install" className="text-sm font-medium text-fd-primary hover:underline">
        Install guide
      </Link>
    </div>
  );
}
