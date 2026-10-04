import { renderOgImage } from '@/lib/og-image';
import { siteConfig } from '@/lib/site.config';
export const dynamic = 'force-static';
export const revalidate = false;
export function GET() { return renderOgImage({ title: siteConfig.name, description: siteConfig.tagline }); }
