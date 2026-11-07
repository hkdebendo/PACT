import type { NextConfig } from 'next';
import { loadEnvConfig } from '@next/env';
import { resolve } from 'node:path';

// One env file for the whole monorepo: the repo-root .env.local (git-ignored).
const root = resolve(process.cwd(), '..', '..');
// forceReload: Next has already cached the env of apps/web (which has no .env file).
loadEnvConfig(root, process.env.NODE_ENV !== 'production', console, true);

const nextConfig: NextConfig = {
  transpilePackages: ['@pact/core', '@pact/llm'],
  devIndicators: false,
  turbopack: { root },
  outputFileTracingRoot: root,
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000',
  },
};

export default nextConfig;
