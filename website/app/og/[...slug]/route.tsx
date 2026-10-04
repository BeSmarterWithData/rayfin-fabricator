import { notFound } from 'next/navigation';
import { source } from '@/lib/source';
import { renderOgImage } from '@/lib/og-image';
import { OG_TERMINAL } from '@/lib/og-paths';

export const dynamic = 'force-static';
export const revalidate = false;

export async function GET(_req: Request, { params }: RouteContext<'/og/[...slug]'>) {
  const { slug } = await params;
  if (slug.at(-1) !== OG_TERMINAL) notFound();
  const page = source.getPage(slug.slice(0, -1));
  if (!page) notFound();
  const section = page.slugs.length > 1 ? source.getPage([page.slugs[0]]) : undefined;
  return renderOgImage({
    title: page.data.title ?? 'Fabricator documentation',
    description: page.data.description,
    eyebrow: section?.data.title ? `Fabricator · ${section.data.title}` : 'Fabricator docs',
  });
}

export function generateStaticParams() {
  return source.generateParams().map(({ slug }) => ({ slug: [...(slug ?? []), OG_TERMINAL] }));
}
