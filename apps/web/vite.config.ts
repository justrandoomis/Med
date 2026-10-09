import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json' with { type: 'json' };

// Brand colours used by the manifest / browser UI. Keep in sync with src/design/tokens.css.
const THEME_LIGHT = '#EEF0F1'; // --ml-color-canvas (light)

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Never auto-reload: the owner may be writing. The app shows an update prompt instead
      // (src/app/PwaUpdatePrompt.tsx) and only reloads when the owner presses the button.
      registerType: 'prompt',
      injectRegister: false, // registered from React via virtual:pwa-register/react
      includeAssets: ['icons/*.svg', 'icons/*.png'],
      manifest: {
        id: '/',
        name: 'MedLevo AI',
        short_name: 'MedLevo',
        description: 'كتابك الطبي الشخصي: اقرأ واكتب وتحقّق من مصدر كل معلومة.',
        lang: 'ar',
        dir: 'rtl',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        theme_color: THEME_LIGHT,
        background_color: THEME_LIGHT,
        categories: ['education', 'medical', 'productivity'],
        icons: [
          { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icons/icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache the app shell only (JS/CSS/HTML/fonts/icons, incl. the pdf.js worker for offline reading).
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,woff2,webmanifest}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: '/index.html',
        // API responses are NEVER cached by the service worker. Offline data is explicit (IndexedDB).
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
        clientsClaim: false,
        skipWaiting: false,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 1600,
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
});
