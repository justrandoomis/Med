import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // one template directory per run, removed at the end (helpers/template.ts)
    globalSetup: ['test/global-setup.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // each file builds its own app with an isolated temp DATA_DIR
    fileParallelism: true,
  },
});
