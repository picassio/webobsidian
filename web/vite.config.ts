import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Web build outputs to ../server/public so the server can serve the SPA.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // Rolldown (Vite 8) accepts a function here, unlike Rollup's legacy
        // object form. Keep the same stable vendor boundaries without pinning
        // every transitive dependency to a chunk.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          const cmPackages = [
            '@codemirror/state', '@codemirror/view', '@codemirror/commands',
            '@codemirror/language', '@codemirror/lang-markdown', '@codemirror/theme-one-dark',
          ];
          if (cmPackages.some((pkg) => id.includes(`/node_modules/${pkg}/`))) return 'codemirror';
          if (/\/node_modules\/(unified|remark-|rehype-)/.test(id)) return 'markdown';
          if (/\/node_modules\/(react|react-dom)\//.test(id)) return 'react';
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
      '/auth': 'http://localhost:8787',
      '/public': 'http://localhost:8787',
      '/share': 'http://localhost:8787', // SSR share page is server-rendered even in dev
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
});
