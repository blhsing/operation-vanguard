import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// Deployed to GitHub Pages under /operation-vanguard/ ; served from / in dev.
const base = process.env.VITE_BASE ?? '/';

/**
 * The standalone build: one HTML file, opened straight off the disk.
 *
 * `file://` is a hostile host. Module scripts are subject to CORS and an origin
 * of `null` fails it, so nothing may be imported at runtime — not the entry, not
 * a lazily-loaded menu, not a stylesheet. Everything therefore has to be one
 * classic script and one style block inside a single document, which is exactly
 * what the zero-binary-assets rule makes possible: there is nothing else to
 * fetch, because every texture, sound, model and map is generated from code.
 */
const standalone = process.env.VANGUARD_STANDALONE === '1';

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
    outDir: standalone ? 'dist-standalone' : 'dist',
    target: 'es2022',
    // A sourcemap is a second file, and the whole point is that there is only one.
    sourcemap: !standalone,
    cssCodeSplit: !standalone,
    // Anything Vite would otherwise emit beside the HTML becomes a data URI.
    assetsInlineLimit: standalone ? Number.MAX_SAFE_INTEGER : 4096,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: standalone
        ? {
            // An IIFE, not an ES module: an inline `<script type="module">` runs
            // from file:// but a linked one does not, and rollup's module output
            // also emits `import` statements that would need resolving.
            format: 'iife',
            // Folds the lazily-loaded loadout editor back into the one bundle.
            inlineDynamicImports: true,
          }
        : {
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
