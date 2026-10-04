'use client';

import { useRef, useState, type ReactNode } from 'react';

export function PromptCard({ title, children }: { title?: string; children: ReactNode }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  async function copy() {
    const text = (bodyRef.current?.textContent ?? '').trim();
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <figure className="not-prose my-5 overflow-hidden rounded-xl border border-fd-border bg-fd-card">
      <figcaption className="flex flex-wrap items-center gap-2 border-b border-fd-border bg-fd-secondary/60 px-3 py-2">
        <span className="inline-flex items-center gap-1.5 rounded-md bg-fd-primary/10 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-fd-primary">Prompt</span>
        {title ? <span className="text-sm font-medium text-fd-foreground">{title}</span> : null}
        <span className="ms-auto flex items-center gap-2">
          <span className="hidden text-xs text-fd-muted-foreground sm:inline">Paste into Fabricator&apos;s chat</span>
          <button type="button" onClick={copy} className="rounded-md px-2 py-1 text-xs font-medium text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground">
            {copied ? 'Copied' : 'Copy'}
          </button>
        </span>
      </figcaption>
      <div ref={bodyRef} className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-[13px] leading-relaxed text-fd-foreground [&_code]:!bg-transparent [&_span]:!text-fd-foreground">
        {children}
      </div>
    </figure>
  );
}
