'use client';

import { useEffect, useState } from 'react';

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export function ProductScreenshot() {
  const src = `${basePath}/screenshots/workbench.webp`;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const image = new Image();
    image.onload = () => setVisible(true);
    image.onerror = () => setVisible(false);
    image.src = src;
  }, [src]);

  if (!visible) return null;

  return (
    <figure className="mx-auto mt-12 w-full max-w-[1100px] overflow-hidden rounded-2xl border border-fd-border bg-fd-card/70 p-2 shadow-[0_20px_70px_rgba(15,108,189,0.18)] backdrop-blur dark:shadow-[0_20px_70px_rgba(53,163,234,0.13)] sm:mt-16 sm:rounded-3xl sm:p-3">
      <img
        src={src}
        alt="The Fabricator workbench: chat on the left builds the app, and the running app appears in the live preview on the right."
        width={1440}
        height={900}
        loading="eager"
        className="block h-auto w-full rounded-xl border border-fd-border/70 bg-fd-muted object-cover sm:rounded-2xl"
        onError={() => setVisible(false)}
      />
    </figure>
  );
}
