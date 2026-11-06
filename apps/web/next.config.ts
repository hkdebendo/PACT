import type { NextConfig } from 'next';
import { loadEnvConfig } from '@next/env';
import { resolve } from 'node:path';

// One env file for the whole monorepo: the repo-root .env.local (git-ignored).
const root = resolve(process.cwd(), '..', '..');
loadEnvConfig(root);

const nextConfig: NextConfig = {
  transpilePackages: ['@pact/core', '@pact/llm'],
  turbopack: { root },
  outputFileTracingRoot: root,
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000',
  },
};

export default nextConfig;
