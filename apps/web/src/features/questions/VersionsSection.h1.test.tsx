// H1: «سجل النسخ» — a derived (translation / paraphrase) version row says that the key it marks is the original's
// current key (the server sends the original's current key on that row; see test/f3/review.test.ts).
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { QuestionDetailResponse, QuestionVersionView, RichText } from '@medlevo/shared';
import { VersionsSection } from './DetailSections';

const rt = (t: string): RichText => ({ v: 1, paragraphs: [{ dir: 'ltr', runs: [{ t }] }] });
const version = (over: Partial<QuestionVersionView> & { attempts?: number; note?: string | null }): QuestionDetailResponse['versions'][number] =>
  ({
    id: 'QV1',
    question_id: 'Q1',
    version_no: 1,
    kind: 'structured',
    derived_from_version_id: null,
    lang: 'en',
    stem: rt('Which point is tender?'),
    extraction_status: 'checks_passed',
    answer_status: 'owner_key',
    correct_option_ids: ['O1'],
    options: [
      { id: 'O1', option_key: 'o1', source_label: 'A', ord: 0, text: rt('Murphy'), raw_text: null, region_id: null, pinned_position: false },
      { id: 'O2', option_key: 'o2', source_label: 'B', ord: 1, text: rt('McBurney'), raw_text: null, region_id: null, pinned_position: false },
    ],
    created_at: 1,
    attempts: 0,
    note: null,
    ...over,
  }) as unknown as QuestionDetailResponse['versions'][number];

describe('VersionsSection (H1)', () => {
  it('a derived row marks the answer the server sends (the original\'s current key) and says where it comes from', () => {
    const original = version({});
    const derived = version({
      id: 'QV2',
      version_no: 2,
      kind: 'translation',
      derived_from_version_id: 'QV1',
      lang: 'ar',
      correct_option_ids: ['D1'],
      options: [
        { id: 'D1', option_key: 'o1', source_label: 'A', ord: 0, text: rt('ترجمة: Murphy'), raw_text: null, region_id: null, pinned_position: false },
        { id: 'D2', option_key: 'o2', source_label: 'B', ord: 1, text: rt('ترجمة: McBurney'), raw_text: null, region_id: null, pinned_position: false },
      ],
    } as Partial<QuestionVersionView>);
    const d = { question: { current: { id: 'QV1' } }, versions: [derived, original] } as unknown as QuestionDetailResponse;
    const { container } = render(
      <MemoryRouter>
        <VersionsSection d={d} />
      </MemoryRouter>,
    );
    const notes = container.querySelectorAll('[data-derived-key-note]');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.textContent).toContain('مفتاح النسخة 1 الحالي');
    const derivedItem = screen.getByText('النسخة 2').closest('li')!;
    expect(derivedItem.textContent).toContain('ترجمة: Murphy');
    expect(derivedItem.querySelectorAll('.qv-correct-inline')).toHaveLength(1);
  });
});
