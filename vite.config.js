import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentApi } from './server/agent/api.js';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

/**
 * Vite config for the standalone Chengdu route planner.
 *
 * - `base: './'` keeps the build relocatable (works from any sub-path).
 * - `node:*` aliases point the shared pipeline modules at a small browser shim,
 *   so the same deterministic fallback runs in the browser and in Node tests.
 * - The `/_AMapService` proxy forwards AMap JS API walking requests to the AMap
 *   REST service and appends the server-side security code.
 * - The `citywalk-agent-api` plugin mounts `/api/agent/*` in dev and preview.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, rootDir, '');
  const amapProxy = {
    target: 'https://restapi.amap.com',
    changeOrigin: true,
    rewrite: (url) => {
      const path = url.replace(/^\/_AMapService/, '');
      return `${path}${path.includes('?') ? '&' : '?'}jscode=${encodeURIComponent(env.AMAP_SECURITY_CODE || '')}`;
    },
  };
  return {
    base: './',
    resolve: {
      alias: [
        { find: 'node:fs', replacement: resolve(rootDir, 'src/ui/browser-node-shim.js') },
        { find: 'node:path', replacement: resolve(rootDir, 'src/ui/browser-node-shim.js') },
        { find: 'node:url', replacement: resolve(rootDir, 'src/ui/browser-node-shim.js') },
      ],
    },
    server: {
      host: '127.0.0.1',
      port: 5178,
      strictPort: true,
      watch: { ignored: ['**/.*.tmpdir/**', '**/*.tmp', '**/node_modules/**'] },
      proxy: { '/_AMapService': amapProxy },
    },
    preview: {
      host: '127.0.0.1',
      port: 5179,
      strictPort: true,
      proxy: { '/_AMapService': amapProxy },
    },
    plugins: [
      {
        // Local AI planning service: /api/agent/*
        // API keys stay on the server; Vite strips the mount prefix.
        name: 'citywalk-agent-api',
        configureServer(server) {
          server.middlewares.use('/api/agent', createAgentApi());
        },
        configurePreviewServer(server) {
          server.middlewares.use('/api/agent', createAgentApi());
        },
      },
    ],
    build: {
      outDir: 'dist',
      assetsDir: 'assets',
      sourcemap: false,
      target: 'es2020',
      rollupOptions: {
        input: {
          main: resolve(rootDir, 'index.html'),
        },
      },
    },
  };
});
