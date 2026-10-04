import { createMDX } from 'fumadocs-mdx/next';

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

const devRewrites = process.env.NODE_ENV === 'development' ? {
  async rewrites() {
    return [
      { source: '/docs.md', destination: '/llms.mdx/docs/_md' },
      { source: '/docs/:path*.md', destination: '/llms.mdx/docs/:path*/_md' },
    ];
  },
} : {};

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  output: process.env.NODE_ENV === 'development' ? undefined : 'export',
  trailingSlash: false,
  basePath,
  images: { unoptimized: true },
  typescript: { ignoreBuildErrors: false },  ...devRewrites,
};

const withMDX = createMDX();
export default withMDX(config);
