// Vitest setup: IndexedDB (fake-indexeddb) for Dexie, DOM cleanup between tests.
import 'fake-indexeddb/auto';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  // (C3) a test file may run in the node environment (`@vitest-environment node`: the CSS lint rule): no DOM there
  if (typeof document === 'undefined') return;
  cleanup();
  document.documentElement.removeAttribute('data-theme');
});
