import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// Deployed to GitHub Pages under /operation-vanguard/ ; served from / in dev.
const base = process.env.VITE_BASE ?? '/';

export default defineConfig({
  base,
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@client': fileURLToPath(new URL('./src/client', import.meta.url)),
      '@server': fileURLToPath(new URL('./src/server', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 2048,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three', 'three-mesh-bvh'],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
