import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// Deployed to GitHub Pages under /operation-vanguard/ ; served from / in dev.
const base = process.env.VITE_BASE ?? '/';

/**
 * The standalone build: an ordinary folder of files, opened straight off the disk.
 *
 * `file://` is a particular host, and exactly one of its rules shapes this build.
 * A *module* script is fetched with CORS semantics, and a `file://` page has an
 * origin of `null`, which fails — so `<script type="module" src="...">` is dead
 * on arrival. A *classic* script tag is not fetched that way and loads fine, as
 * do stylesheets and images.
 *
 * So the output is a classic script, and everything else follows: rollup cannot
 * code-split a classic bundle, which is why there is one `.js` rather than a
 * vendor chunk beside it, and why the lazily-loaded loadout editor is folded
 * back in. What makes the whole thing viable is the zero-binary-assets rule —
 * there are no textures, sounds or models to ship, because they are all
 * generated from code at runtime.
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
    outDir: standalone ? 'offline' : 'dist',
    target: 'es2022',
    // A sourcemap is dead weight in a folder somebody is going to zip and email,
    // and it is the one emitted file nothing ever references.
    sourcemap: !standalone,
    cssCodeSplit: !standalone,
    assetsInlineLimit: 4096,
    assetsDir: standalone ? '.' : 'assets',
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: standalone
        ? {
            // An IIFE, not an ES module. A linked module script cannot load from
            // file:// at all, and rollup's module output emits `import`
            // statements that would need resolving at runtime.
            format: 'iife',
            // Folds the lazily-loaded loadout editor back in: a classic bundle
            // has no mechanism to fetch a second chunk.
            inlineDynamicImports: true,
            // Content hashes buy nothing here — there is no HTTP cache to bust —
            // and they make a folder somebody is going to zip and email harder
            // to read. Flat, stable, three files.
            entryFileNames: 'vanguard.js',
            assetFileNames: 'vanguard.[ext]',
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
