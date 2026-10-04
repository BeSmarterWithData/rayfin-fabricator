import { ImageResponse } from 'next/og';
import { siteConfig } from '@/lib/site.config';

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = 'image/png';

export function renderOgImage({ title, description, eyebrow }: { title: string; description?: string; eyebrow?: string }) {
  return new ImageResponse((
    <div style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', backgroundColor: '#07111d', backgroundImage: 'radial-gradient(ellipse 50% 70% at 50% 0%, rgba(53, 163, 234, 0.24), transparent), radial-gradient(ellipse 35% 55% at 72% 12%, rgba(70, 204, 176, 0.16), transparent)', padding: '72px 80px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}><div style={{ width: 20, height: 20, borderRadius: 999, backgroundColor: '#35a3ea' }} /><div style={{ display: 'flex', fontSize: 26, color: '#9bd8ff', letterSpacing: 2, textTransform: 'uppercase' }}>{eyebrow ?? siteConfig.name}</div></div>
      <div style={{ display: 'flex', flexDirection: 'column' }}><div style={{ display: 'flex', fontSize: title.length > 42 ? 62 : 76, fontWeight: 700, color: '#f8fafc', lineHeight: 1.1, letterSpacing: -1.5 }}>{title}</div>{description ? <div style={{ display: 'flex', marginTop: 24, fontSize: 30, color: '#b6c9d8', lineHeight: 1.35 }}>{truncate(description, 140)}</div> : null}</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 24, color: '#6d8496' }}><div style={{ display: 'flex' }}>spatney.github.io/rayfin-fabricator</div><div style={{ display: 'flex' }}>Fabricator {siteConfig.appVersion}</div></div>
    </div>
  ), OG_SIZE);
}
function truncate(value: string, max: number): string { return value.length <= max ? value : `${value.slice(0, max).trimEnd()}…`; }
