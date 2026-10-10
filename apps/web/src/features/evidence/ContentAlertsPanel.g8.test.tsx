// G8 (AC-26) regression: every affected item of a content-change alert is recognisable — an Arabic type label (never
// the internal key such as «question_attempt»), its title, and a link that opens it in the app.
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ContentAlertView } from '@medlevo/shared';
import { AlertCard } from './ContentAlertsPanel';

const alert: ContentAlertView = {
  id: 'A1',
  kind: 'key_corrected',
  kind_label_ar: 'تصحيح مفتاح إجابة',
  severity: 'answer_change',
  severity_label_ar: 'قد تتغير الإجابة',
  source_id: 'S1',
  source_title: 'G8 Revision Bank',
  source_version_id: 'V1',
  from_version_id: null,
  summary: 'صححتَ مفتاح الإجابة: محاولتان سابقتان، منها 2 ستتغير نتيجتها لو قُيّمت بالمفتاح الجديد. لم يُعَد تقييم أي محاولة تلقائيًا.',
  status: 'open',
  created_at: 1,
  acknowledged_at: null,
  resolved_at: null,
  counts: { still_valid: 0, needs_regeneration: 0, needs_review: 4 },
  change: null,
  items: [
    { type: 'question_version', id: 'QV1', impact: 'needs_review', impact_label_ar: 'يحتاج مراجعة', frozen: false, reason_ar: 'نسخة سابقة', title: 'G8 set: which imaging test is preferred in adults? (النسخة 1)', href: '/questions/Q1' },
    { type: 'question_attempt', id: 'QA1', impact: 'needs_review', impact_label_ar: 'يحتاج مراجعة', frozen: false, reason_ar: 'محاولة سُجلت صحيحة', title: 'G8 set: which imaging test is preferred in adults?', href: '/questions/Q1' },
    { type: 'flashcard', id: 'C1', impact: 'needs_review', impact_label_ar: 'يحتاج مراجعة', frozen: false, reason_ar: 'بطاقة من خطأ', title: 'أين يبدأ الألم؟', href: '/review/cards/C1' },
    { type: 'case', id: 'K1', impact: 'needs_review', impact_label_ar: 'يحتاج مراجعة', frozen: false, reason_ar: null, title: null, href: null },
    { type: 'unknown_future_type', id: 'X1', impact: 'needs_review', impact_label_ar: 'يحتاج مراجعة', frozen: false, reason_ar: null, title: null },
  ],
};

describe('AlertCard (G8, AC-26)', () => {
  it('labels every item in Arabic and links the ones that can be opened', () => {
    render(
      <MemoryRouter>
        <ul>
          <AlertCard alert={alert} onChanged={() => {}} />
        </ul>
      </MemoryRouter>,
    );
    const list = screen.getByText(/العناصر المتأثرة \(5\)/).closest('details')!;
    const text = list.textContent ?? '';
    for (const raw of ['question_attempt', 'question_version', 'flashcard', 'unknown_future_type', 'case']) expect(text).not.toContain(raw);
    expect(text).toContain('محاولة إجابة');
    expect(text).toContain('حالة سريرية');
    expect(text).toContain('عنصر مشتق');
    const links = within(list).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/questions/Q1', '/questions/Q1', '/review/cards/C1']);
    expect(within(list).getByRole('link', { name: 'أين يبدأ الألم؟' })).toBeTruthy();
  });
});
