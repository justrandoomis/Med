// Derived question versions on the question screen (§35, §37, track F3): disabled with the server's reason without an
// AI provider; a published translation is labelled «نسخة مشتقة», shown only on demand beside the original, with the
// ORIGINAL option ids and the same key; a translation that failed its checks shows the reasons and no text.
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DERIVED_VERSION_NOTICE_AR, type QuestionDerivationView, type QuestionDerivationsResponse, type QuestionVersionView, type RichText } from '@medlevo/shared';
import { setFetchImpl } from '../../lib/api';
import { DerivedVersionsSection } from './DerivedVersions';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const rt = (t: string, dir: 'ltr' | 'rtl' = 'ltr'): RichText => ({ v: 1, paragraphs: [{ dir, runs: [{ t }] }] });
const original = { id: 'QV1', question_id: 'Q1', version_no: 1, lang: 'en' } as unknown as QuestionVersionView;

const published: QuestionDerivationView = {
  id: 'DV1',
  question_id: 'Q1',
  source_version_id: 'QV1',
  kind: 'translation',
  lang: 'ar',
  status: 'published',
  status_label_ar: 'نُشرت بعد التحقق',
  issues: [],
  derived: {
    version_id: 'QV2',
    kind: 'translation',
    lang: 'ar',
    label_ar: 'ترجمة مشتقة',
    notice_ar: DERIVED_VERSION_NOTICE_AR,
    derived_from_version_id: 'QV1',
    derived_from_version_no: 1,
    from_current: true,
    stale_note_ar: null,
    stem: rt('أي نقطة يكون فيها الألم نموذجيًا في التهاب الزائدة الحاد؟', 'rtl'),
    has_negation: false,
    options: [
      { id: 'OPT-A', option_key: 'a', display_label: 'A', text: rt('نقطة Murphy', 'rtl') },
      { id: 'OPT-B', option_key: 'b', display_label: 'B', text: rt('نقطة McBurney', 'rtl') },
    ],
    correct_option_keys: ['b'],
    answer_status: 'source_key',
    model: 'test',
    created_at: 1,
  },
  job: null,
  error_ar: null,
  created_at: 1,
  updated_at: 1,
};
const rejected: QuestionDerivationView = {
  ...published,
  id: 'DV2',
  kind: 'paraphrase',
  lang: 'en',
  status: 'needs_review',
  status_label_ar: 'تحتاج مراجعة — لم تُنشر',
  issues: [{ check: 'negation', reason_ar: 'النفي «NOT» في الأصل غائب عن النسخة المشتقة.', by: 'deterministic' }],
  derived: null,
};

function serve(r: Partial<QuestionDerivationsResponse>) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  setFetchImpl(async (url, init) => {
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ method, url, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });
    if (method === 'POST') return json({ derivation: { ...published, id: 'DV3', status: 'queued', derived: null } });
    return json({ question_id: 'Q1', current_version_id: 'QV1', derivations: [], can_derive: { available: true, reason_ar: null }, ...r });
  });
  return calls;
}

afterEach(() => setFetchImpl(null));

describe('DerivedVersionsSection', () => {
  it('without an AI provider: every action is disabled with the server’s reason', async () => {
    const calls = serve({ can_derive: { available: false, reason_ar: 'الترجمة وإعادة الصياغة تحتاجان مزود ذكاء اصطناعي (ANTHROPIC_API_KEY).' } });
    render(<DerivedVersionsSection questionId="Q1" original={original} />);
    const reason = await screen.findByText('الترجمة وإعادة الصياغة تحتاجان مزود ذكاء اصطناعي (ANTHROPIC_API_KEY).');
    const translate = screen.getByRole('button', { name: 'ترجمة إلى العربية' });
    expect(translate).toHaveProperty('disabled', true);
    expect(translate.getAttribute('aria-describedby')).toBe(reason.id);
    expect(screen.getByRole('button', { name: 'إعادة صياغة' })).toHaveProperty('disabled', true);
    // an English original is not offered a translation into English
    expect(screen.queryByRole('button', { name: 'ترجمة إلى الإنجليزية' })).toBeNull();
    expect(screen.getByText('لا توجد نسخ مشتقة لهذا السؤال.')).toBeTruthy();
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('a published translation is labelled, shown on demand, keeps the original option ids and the same key', async () => {
    serve({ derivations: [published, rejected] });
    render(<DerivedVersionsSection questionId="Q1" original={original} />);
    expect(await screen.findByText('نُشرت بعد التحقق')).toBeTruthy();
    expect(screen.queryByText(/نقطة McBurney/)).toBeNull(); // not shown until asked
    const toggle = screen.getByRole('button', { name: 'اعرض النسخة المشتقة' });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(`ترجمة مشتقة: ${DERIVED_VERSION_NOTICE_AR}`)).toBeTruthy();
    const items = document.querySelectorAll('[data-option-id]');
    expect([...items].map((li) => li.getAttribute('data-option-id'))).toEqual(['OPT-A', 'OPT-B']);
    expect(items[1]!.textContent).toContain('الإجابة (مفتاح الأصل نفسه)');
    expect(items[0]!.textContent).not.toContain('الإجابة');
    // the failed paraphrase: its reasons, no text, no toggle
    expect(screen.getByText('تحتاج مراجعة — لم تُنشر')).toBeTruthy();
    expect(screen.getByText('النفي «NOT» في الأصل غائب عن النسخة المشتقة.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /النسخة المشتقة/ })).toHaveLength(1);
  });

  it('requesting a translation posts the kind and the language, then shows the queued derivation', async () => {
    const calls = serve({});
    render(<DerivedVersionsSection questionId="Q1" original={original} />);
    const btn = await screen.findByRole('button', { name: 'ترجمة إلى العربية' });
    await waitFor(() => expect(btn).toHaveProperty('disabled', false));
    fireEvent.click(btn);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ url: '/api/questions/Q1/derived', body: { kind: 'translation', lang: 'ar' } });
  });
});
