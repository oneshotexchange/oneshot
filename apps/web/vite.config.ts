import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'NEXT_PUBLIC_');
  // Only these explicitly public settings enter browser JavaScript. Server
  // credentials and process.env must never be serialized into the web artifact.
  const names = ['NEXT_PUBLIC_PRIVY_APP_ID', 'NEXT_PUBLIC_PRIVY_CLIENT_ID', 'NEXT_PUBLIC_API_URL'];
  return {
    define: Object.fromEntries(names.map(name => [`process.env.${name}`, JSON.stringify(process.env[name] ?? env[name] ?? '')])),
    esbuild: { jsx: 'automatic' },
    build: {
      outDir: 'dist', sourcemap: false, reportCompressedSize: false,
      rolldownOptions: {
        onLog(level, log, handler) {
          // This entire artifact runs in the browser; server/client boundaries
          // from dependency packages do not apply to a static SPA.
          if (log.code === 'MODULE_LEVEL_DIRECTIVE' && log.message.includes('use client')) return;
          handler(level, log);
        },
        output: {
          codeSplitting: {
            groups: [
              { name: 'charts', test: /node_modules[\\/]lightweight-charts/, priority: 30 },
              { name: 'evm-crypto', test: /node_modules[\\/](?:viem|abitype|@noble|ox)/, priority: 25 },
              { name: 'ui-vendor', test: /node_modules[\\/](?:lucide-react|gsap|@gsap)/, priority: 20 },
              { name: 'router-zod', test: /node_modules[\\/](?:react-router|zod)/, priority: 15 },
            ],
          },
        },
      },
    },
    server: { proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false }, '/g/': { target: 'http://127.0.0.1:3001', changeOrigin: false, rewrite: path => path.replace(/^\/g\//, '/api/oneshot/genesis/share/') } } },
  };
});
