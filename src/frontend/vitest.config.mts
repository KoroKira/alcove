/// <reference types="vitest" />
import { defineConfig, type Plugin } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Bypass Sass/PostCSS entirely — style imports resolve to an empty module.
// We never assert on visual styling in tests, and booting the CSS pipeline
// forces us onto a newer sass than the app itself pins.
const stubStylesPlugin = (): Plugin => ({
  name: 'stub-styles',
  enforce: 'pre',
  resolveId(id) {
    if (/\.(scss|sass|css)$/.test(id)) return '\0virtual:styles-stub';
    return null;
  },
  load(id) {
    if (id === '\0virtual:styles-stub') return 'export default {};';
    return null;
  },
});

// Kept separate from vite.config.mts to skip the PWA plugin (which walks
// the whole publicDir on startup and slows tests down for zero benefit).
export default defineConfig({
  plugins: [stubStylesPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(HERE, 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // Component tests hit the DOM; a shared JSDOM instance is fine and much
    // faster than spinning one per file.
    isolate: false,
    coverage: {
      reporter: ['text', 'html'],
      exclude: ['node_modules/**', 'dist/**', 'src/test/**', '**/*.d.ts'],
    },
  },
});
