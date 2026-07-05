import { defineConfig, loadEnv } from "vite";
import { VitePWA } from 'vite-plugin-pwa';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    server: {
      port: 3003,
      open: false,
      proxy: {
        '/api': {
          target: 'http://localhost:8000',
          changeOrigin: false,
        },
        '/ws': {
          target: 'ws://localhost:8000',
          ws: true,
          changeOrigin: false,
        },
        '/posthog': {
          target: 'https://eu.i.posthog.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/posthog/, ''),
        },
      },
    },
    publicDir: "public",
    optimizeDeps: {
      esbuildOptions: {
        target: "es2022",
        treeShaking: true,
      },
    },
    build: {
      chunkSizeWarningLimit: 1600,
      rollupOptions: {
        output: {
          // Split the large, self-contained vendor libs into their own chunks so
          // they load in parallel and cache independently. Combined with the
          // lazy-loaded pad components, the initial canvas view no longer pays
          // for Monaco/Mermaid/KaTeX (only pulled when a document pad opens).
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return;
            if (id.includes('@atyrode/excalidraw')) return 'excalidraw';
            if (id.includes('monaco')) return 'monaco';
            if (id.includes('mermaid')) return 'mermaid';
            if (id.includes('katex')) return 'katex';
          },
        },
      },
    },
    plugins: [
      VitePWA({
        registerType: 'autoUpdate',
        devOptions: { enabled: false },
        workbox: {
          globPatterns: ['**/*.{css,html,ico,png,svg,woff2}'],
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
          navigateFallback: null,
          runtimeCaching: [
            {
              urlPattern: /^\/api\/users\/me/,
              handler: 'NetworkFirst',
              options: { cacheName: 'api-user', networkTimeoutSeconds: 3 },
            },
            {
              urlPattern: /^\/api\/pad\//,
              handler: 'NetworkFirst',
              options: { cacheName: 'api-pads', networkTimeoutSeconds: 3 },
            },
          ],
        },
        manifest: {
          name: 'pad.ws',
          short_name: 'pad.ws',
          description: 'Votre espace de travail visuel',
          theme_color: '#1e1e2e',
          background_color: '#1e1e2e',
          display: 'standalone',
          orientation: 'any',
          start_url: '/',
          icons: [
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
          ],
        },
      }),
    ],
  };
});
