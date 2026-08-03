import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// The web app lives in src/web and builds to web/dist, which the Fastify
// server serves in production (`npm start`). During development the dev server
// proxies API + websocket calls to the running Node backend.
export default defineConfig({
  root: resolve(__dirname, 'src/web'),
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, 'web/dist'),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4180',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
