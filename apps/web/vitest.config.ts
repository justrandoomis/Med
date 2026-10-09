import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Unit / component tests run in jsdom with fake-indexeddb (see test/setup.ts).
// The PWA plugin is intentionally not loaded here.
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify('test'),
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    css: false,
    restoreMocks: true,
  },
});
