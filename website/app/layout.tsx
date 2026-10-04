import './global.css';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { absoluteUrl, siteConfig } from '@/lib/site.config';
import { FabricatorSearchDialog } from '@/components/search-dialog';
import { OG_HOME_PATH } from '@/lib/og-paths';

const inter = Inter({ subsets: ['latin'] });
const ogAlt = `${siteConfig.name} — ${siteConfig.tagline}`;

export const metadata: Metadata = {
  metadataBase: new URL(`${siteConfig.baseUrl}/`),
  title: { default: `${siteConfig.name} — ${siteConfig.tagline}`, template: `%s | ${siteConfig.name}` },
  description: siteConfig.description,
  applicationName: siteConfig.name,
  alternates: { canonical: absoluteUrl('/') },
  openGraph: {
    siteName: siteConfig.name,
    type: 'website',
    url: absoluteUrl('/'),
    images: [{ url: absoluteUrl(OG_HOME_PATH), width: 1200, height: 630, alt: ogAlt }],
  },
  twitter: { card: 'summary_large_image', images: [{ url: absoluteUrl(OG_HOME_PATH), alt: ogAlt }] },
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <head>
        <link rel="alternate" type="text/plain" href={absoluteUrl('/llms.txt')} title="llms.txt" />
        <link rel="alternate" type="text/plain" href={absoluteUrl('/llms-full.txt')} title="llms-full.txt" />
      </head>
      <body className="flex min-h-screen flex-col">
        <RootProvider search={{ SearchDialog: FabricatorSearchDialog, options: { type: 'static' } }}>
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
