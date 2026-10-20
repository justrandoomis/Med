// H1 item 11 (AC-04) — the web producers of a page label name an UNNUMBERED page among numbered pages by its file
// position, even from a page list cached before the server sent `numbered_version` (offline download).
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/lib/localdb';
import { apiKeyFor } from '../../src/lib/offline';
import { localSessionPageLabel } from '../../src/features/home/HomeScreen';
import { clearDb } from './helpers';

beforeEach(async () => {
  await clearDb();
});

describe('H1 — Home «continue» from a downloaded page list (AC-04)', () => {
  it('an unnumbered cover among printed pages is «الصفحة 1 في الملف», never «ص 1»', async () => {
    // a list stored by an older download: no `numbered_version` on its pages
    await getDb().apiCache.put({
      key: apiKeyFor('/api/sources/S1/versions/V1/pages'),
      value: {
        version: { id: 'V1' },
        pages: [
          { id: 'P0', page_index: 0, printed_label: null, kind: 'page' },
          { id: 'P1', page_index: 1, printed_label: '1', kind: 'page' },
          { id: 'P2', page_index: 2, printed_label: '2', kind: 'page' },
        ],
      },
      storedAt: Date.now(),
    });
    expect(await localSessionPageLabel({ sourceId: 'S1', versionId: 'V1', location: { page_index: 0 } })).toBe('الصفحة 1 في الملف');
    // the printed page 1 (2nd in the file) keeps its printed number
    expect(await localSessionPageLabel({ sourceId: 'S1', versionId: 'V1', location: { page_id: 'P1' } })).toBe('ص 1 (الصفحة 2 في الملف)');
  });

  it('a version with no printed numbers at all keeps the plain «ص N» (file order IS the page number)', async () => {
    await getDb().apiCache.put({
      key: apiKeyFor('/api/sources/S2/versions/V2/pages'),
      value: { version: { id: 'V2' }, pages: [{ id: 'Q0', page_index: 0, printed_label: null, kind: 'page' }, { id: 'Q1', page_index: 1, printed_label: null, kind: 'page' }] },
      storedAt: Date.now(),
    });
    expect(await localSessionPageLabel({ sourceId: 'S2', versionId: 'V2', location: { page_index: 1 } })).toBe('ص 2');
  });
});
