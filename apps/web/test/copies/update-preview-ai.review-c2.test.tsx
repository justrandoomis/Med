// Review of Phase 1 completion track C2 — AOS-19I.5 on the one path of published AI output the builder left unmarked
// (review R5; failed before the fix): a follower's «اعرض التغييرات» → «طبّق التحديث» showed only «أضاف 2 …» for a new
// version of a classmate's explanation that holds a saved AI answer and a handwriting reading; it was marked only after
// it was applied. Now the preview says so before anything is applied, with the same words as the publication page.
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { DocumentCopyView, UpstreamPreview } from '@medlevo/shared';
import { ToastProvider } from '../../src/design';
import { setFetchImpl } from '../../src/lib/api';
import { UpdatePreviewDialog } from '../../src/features/copies/UpdatePreviewDialog';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const HASAN = { id: 'u_h', display_name: 'حسن', avatar_url: null };
const SUBJECT = { id: 'S1', kind: 'subject' as const, title: 'التشريح' };

const COPY: DocumentCopyView = {
  id: 'C2',
  mode: 'followed',
  source_id: 'SRC1',
  document_key: 'source:SRC1',
  lecture: { space_id: 'SPA', lecture_id: 'L1', subject: SUBJECT, title: 'Renal anatomy', version_id: 'V1', version_no: 1 },
  publication: { id: 'PUB1', space_id: 'SPA', title: 'شرح حسن', author: HASAN, applied_version_no: 1, head_version_no: 2, status: 'active', status_note_ar: null, built_on_version_no: 1, pending_built_on_version_no: 1 },
  personal_layer_id: 'LAY_C2',
  copied_layer_id: 'LAY_F',
  collab_doc_id: null,
  update_policy: 'preview',
  reanchor_policy: 'preview',
  pending_version_no: 2,
  newer_official_version: null,
  official: { status: 'published', withdrawn: null, file_removed: false, note_ar: null },
  created_at: 1,
  updated_at: 1,
} as DocumentCopyView;

const PREVIEW: UpstreamPreview = {
  publication_id: 'PUB1',
  from_version_no: 1,
  to_version_no: 2,
  change_note: null,
  counts: { added: 2, removed: 0, changed: 0 },
  pages: [{ page: { page_id: 'P3', page_index: 2, label_ar: 'ص 3', thumbnail: false }, added: 2, removed: 0, changed: 0 }],
  personal_items_affected: 0,
  summary_ar: 'أضاف عنصرين في صفحة واحدة',
};

function serve(notes: Array<{ origin: string }>) {
  setFetchImpl(async (url) => {
    const path = url.split('?')[0]!;
    if (path === '/api/copies/C2/upstream') return json(PREVIEW);
    if (path === '/api/spaces/SPA/publications/PUB1/versions/2/items') return json({ publication_id: 'PUB1', version_no: 2, items: [], notes: notes.map((n, i) => ({ id: `N${i}`, title: null, body: { v: 1, paragraphs: [] }, anchor: null, ...n })), note_pages: [], redacted: false });
    return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
  });
}

function mount() {
  render(
    <ToastProvider>
      <MemoryRouter>
        <UpdatePreviewDialog open onClose={() => undefined} copy={COPY} />
      </MemoryRouter>
    </ToastProvider>,
  );
}
afterEach(() => setFetchImpl(null));

describe('AOS-19I.5 — an update that brings machine-generated content says so before it is applied', () => {
  it('a saved AI answer and a handwriting reading in the new version are named in the preview', async () => {
    serve([{ origin: 'ai_answer' }, { origin: 'handwriting_recognition' }, { origin: 'owner' }]);
    mount();
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(/أضاف عنصرين/);
    expect(await within(dialog).findByText(/فيه محتوى مولَّد آليًا: إجابة مولَّدة محفوظة كملاحظة، نص واحد مقروء آليًا من خط اليد/)).toBeTruthy();
  });

  it('a version written by hand only says nothing of the kind', async () => {
    serve([{ origin: 'owner' }]);
    mount();
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(/أضاف عنصرين/);
    // give the items request its turn
    await new Promise((r) => setTimeout(r, 30));
    expect(within(dialog).queryByText(/مولَّد آليًا/)).toBeNull();
  });
});
