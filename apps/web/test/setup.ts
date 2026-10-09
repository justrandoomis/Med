// Vitest setup: IndexedDB (fake-indexeddb) for Dexie, DOM cleanup between tests.
import 'fake-indexeddb/auto';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
});
