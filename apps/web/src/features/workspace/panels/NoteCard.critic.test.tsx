// Critic round regression (§28 «Save AI Answer as Note … لا ينزع صفة «مولد» عن الإجابة»): a saved AI answer
// (origin 'ai_answer') looked exactly like the owner's own note in «ملاحظاتي» — only its first paragraph said it was
// generated, and editing that paragraph away left nothing. The list now marks it from the stored origin.
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { RichText } from '@medlevo/shared';
import { getDb } from '../../../lib/localdb';
import { NoteCard } from './MineTab';
import type { WorkspaceNoteRow } from '../data/local';

const body = (t: string): RichText => ({ v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t }] }] });
const anchor = { type: 'page' as const, source_id: 'S1', version_id: 'V1', page_id: 'P1', page_index: 0, space: 'page_norm' as const };
const note = (id: string, origin: WorkspaceNoteRow['origin']): WorkspaceNoteRow => ({
  id,
  nodeId: null,
  anchorKey: 'source_page:P1',
  title: null,
  body: body('ألم حول السرة ثم الحفرة الحرقفية'),
  anchor,
  origin,
  conflictOfId: null,
  sourceId: 'S1',
  rev: 1,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  syncState: 'synced',
});

beforeEach(async () => {
  await getDb().open();
});

describe('note card origin', () => {
  it('a saved AI answer is marked as generated, not as a source', () => {
    render(
      <ul>
        <NoteCard note={note('N-AI', 'ai_answer')} pageLabel="ص 11" onEdit={() => undefined} onGo={null} />
      </ul>,
    );
    expect(screen.getByText('إجابة مولَّدة محفوظة — ليست مصدرًا')).toBeTruthy();
  });

  it("the owner's own note carries no such mark", () => {
    render(
      <ul>
        <NoteCard note={note('N-OWN', 'owner')} pageLabel="ص 11" onEdit={() => undefined} onGo={null} />
      </ul>,
    );
    expect(screen.queryByText(/إجابة مولَّدة محفوظة/)).toBeNull();
  });
});
