import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/worker/**/*.test.ts', 'apps/indexer/**/*.test.ts', 'apps/web/lib/**/*.test.ts', 'apps/api/lib/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.next/**'],
    environment: 'node',
    testTimeout: 15000,
  },
});
