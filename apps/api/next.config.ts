import { resolve } from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  // Let disposable local QA coexist with the owner's ordinary development server.
  distDir: process.env.ONESHOT_API_ISOLATED_PREVIEW === 'true' ? '.next-indexed-preview' : '.next',
  output: 'standalone',
  outputFileTracingRoot: resolve(__dirname, '../..'),
  transpilePackages: ['@b20/sdk', '@oneshot/evm'],
  poweredByHeader: false,
};
export default config;
