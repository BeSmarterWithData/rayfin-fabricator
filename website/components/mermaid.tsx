'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useTheme } from 'next-themes';

type Swatch = { fill: string; stroke: string; text: string; dashed?: boolean };

const NODE_CLASSES: Record<'dark' | 'light', Record<string, Swatch>> = {
  dark: {
    actor: { fill: '#102235', stroke: '#35a3ea', text: '#e6f4ff' },
    service: { fill: '#102b2b', stroke: '#46ccb0', text: '#e8fffa' },
    store: { fill: '#101d2b', stroke: '#5bb7f0', text: '#e3f3ff' },
    external: { fill: '#1d1b26', stroke: '#6f7f9d', text: '#e2dff0', dashed: true },
    experimental: { fill: '#241f16', stroke: '#b98b36', text: '#f2e7d3', dashed: true },
  },
  light: {
    actor: { fill: '#eef6fc', stroke: '#0f6cbd', text: '#0b2d4a' },
    service: { fill: '#eefaf9', stroke: '#1aa1be', text: '#08343c' },
    store: { fill: '#eaf3fb', stroke: '#4d91c8', text: '#0f2a3d' },
    external: { fill: '#f3f1fa', stroke: '#9a93b5', text: '#251f3d', dashed: true },
    experimental: { fill: '#fdf6e8', stroke: '#c9a45c', text: '#3d2f12', dashed: true },
  },
};

function withNodeClasses(source: string, dark: boolean): string {
  const breakAt = source.indexOf('\n');
  if (breakAt === -1) return source;
  const header = source.slice(0, breakAt);
  if (!/^\s*(flowchart|graph)\b/.test(header)) return source;
  const defs = Object.entries(NODE_CLASSES[dark ? 'dark' : 'light'])
    .map(([name, s]) => `  classDef ${name} fill:${s.fill},stroke:${s.stroke},color:${s.text},stroke-width:1.5px${s.dashed ? ',stroke-dasharray:4 3' : ''}`)
    .join('\n');
  return `${header}\n${defs}\n${source.slice(breakAt + 1)}`;
}

export function Mermaid({ chart }: { chart: string }) {
  const id = useId().replace(/:/g, '');
  const containerRef = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function render() {
      const mermaid = (await import('mermaid')).default;
      const dark = resolvedTheme === 'dark';
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        fontFamily: 'inherit',
        theme: 'base',
        themeVariables: {
          background: 'transparent',
          primaryColor: dark ? '#102235' : '#eef6fc',
          primaryBorderColor: dark ? '#35a3ea' : '#0f6cbd',
          primaryTextColor: dark ? '#e6f4ff' : '#0b2d4a',
          lineColor: dark ? '#72b7e6' : '#3d78a8',
          textColor: dark ? '#d7e8f5' : '#17364d',
          clusterBkg: dark ? '#0e1822' : '#f6fbff',
          clusterBorder: dark ? '#264966' : '#c7dff2',
          nodeBorder: dark ? '#35a3ea' : '#0f6cbd',
          edgeLabelBackground: dark ? '#0e1822' : '#f6fbff',
          fontSize: '14px',
        },
      });
      try {
        const { svg } = await mermaid.render(`mermaid-${id}`, withNodeClasses(chart.trim(), dark));
        if (!cancelled) { setSvg(svg); setError(''); }
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); }
    }
    void render();
    return () => { cancelled = true; };
  }, [chart, id, resolvedTheme]);

  if (error) return <figure className="not-prose my-5 overflow-hidden rounded-xl border border-fd-border bg-fd-card"><figcaption className="border-b border-fd-border bg-fd-secondary/60 px-3 py-2 text-xs text-fd-muted-foreground">Diagram could not be rendered: {error}</figcaption><pre className="overflow-x-auto px-4 py-3 font-mono text-[13px]">{chart}</pre></figure>;
  return <div ref={containerRef} role="img" className="not-prose my-5 flex justify-center overflow-x-auto rounded-xl border border-fd-border bg-fd-card p-5 [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />;
}
