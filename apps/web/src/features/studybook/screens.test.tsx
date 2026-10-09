// Terminology dictionary and explanation-rules screens against a mocked server: empty dictionary (nothing seeded),
// add with client validation + the server body, delete with its impact; rules show where each value comes from,
// save only the owner's layer, and folder rules inherit unless set.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ExplanationRulesResponse, MedicalTermView } from '@medlevo/shared';
import { EXPLANATION_TEMPLATES } from '@medlevo/shared';
import { ToastProvider } from '../../design';
import { setFetchImpl } from '../../lib/api';
import { RulesScreen } from './RulesScreen';
import { TermsScreen } from './TermsScreen';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
interface Call {
  method: string;
  url: string;
  body: unknown;
}

function mount(node: React.ReactNode, path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>{node}</ToastProvider>
    </MemoryRouter>,
  );
}

afterEach(() => setFetchImpl(null));

describe('TermsScreen', () => {
  let terms: MedicalTermView[];
  let calls: Call[];
  beforeEach(() => {
    terms = [];
    calls = [];
    setFetchImpl(async (url, init) => {
      const method = (init.method ?? 'GET').toUpperCase();
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      calls.push({ method, url, body });
      if (url === '/api/studybook/terms' && method === 'GET') return json({ terms });
      if (url === '/api/studybook/terms' && method === 'POST') {
        const t: MedicalTermView = { id: `t${terms.length + 1}`, origin: 'owner', updated_at: 1, synonyms: [], abbreviation: null, explanation_ar: null, accepted_translation_ar: null, owner_preferred_ar: null, ...(body as object), term_en: String(body!.term_en) };
        terms.push(t);
        return json({ term: t });
      }
      if (url.startsWith('/api/studybook/terms/') && method === 'DELETE') {
        terms = terms.filter((t) => !url.endsWith(t.id));
        return json({ ok: true });
      }
      return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
    });
  });

  it('an empty dictionary says nothing is seeded; adding validates on the client and sends the server body', async () => {
    mount(<TermsScreen />);
    expect(await screen.findByText('القاموس فارغ')).toBeTruthy();
    expect(screen.getByText(/لا يأتي القاموس بمصطلحات جاهزة/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'أضف مصطلحًا' }));
    const dialog = await screen.findByRole('dialog', { name: 'مصطلح جديد' });
    // submitting without a term shows the field error (nothing sent)
    fireEvent.click(within(dialog).getByRole('button', { name: 'أضف إلى القاموس' }));
    expect(await within(dialog).findByText('اكتب المصطلح بالإنجليزية كما يرد في مصادرك.')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    fireEvent.change(within(dialog).getByLabelText(/المصطلح بالإنجليزية/), { target: { value: 'Ultrasound' } });
    fireEvent.change(within(dialog).getByLabelText(/الاختصار/), { target: { value: 'US' } });
    fireEvent.change(within(dialog).getByLabelText(/المرادفات/), { target: { value: 'sonography، echo' } });
    fireEvent.change(within(dialog).getByLabelText(/ترجمتك المفضلة/), { target: { value: 'الإيكو' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'أضف إلى القاموس' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/api/studybook/terms');
    expect(post.body).toEqual({ term_en: 'Ultrasound', abbreviation: 'US', synonyms: ['sonography', 'echo'], explanation_ar: null, accepted_translation_ar: null, owner_preferred_ar: 'الإيكو' });
    // listed with its LTR term, preferred rendering and synonyms
    const list = screen.getByRole('list', { name: 'المصطلحات' });
    expect(within(list).getByText('Ultrasound')).toBeTruthy();
    expect(within(list).getByText('الإيكو')).toBeTruthy();
    expect(within(list).getByText('sonography')).toBeTruthy();
    expect(screen.getByText('مصطلح واحد')).toBeTruthy();

    // a duplicate is refused before any request
    fireEvent.click(screen.getByRole('button', { name: 'أضف مصطلحًا' }));
    const d2 = await screen.findByRole('dialog', { name: 'مصطلح جديد' });
    fireEvent.change(within(d2).getByLabelText(/المصطلح بالإنجليزية/), { target: { value: 'ultrasound' } });
    fireEvent.click(within(d2).getByRole('button', { name: 'أضف إلى القاموس' }));
    expect(await within(d2).findByText(/موجود في قاموسك/)).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    fireEvent.click(within(d2).getByRole('button', { name: 'إلغاء' }));
  });

  it('deleting states its impact (source text and saved explanations unchanged) and removes the row', async () => {
    terms = [{ id: 't9', term_en: 'CT abdomen', abbreviation: 'CT', synonyms: [], explanation_ar: null, accepted_translation_ar: null, owner_preferred_ar: null, origin: 'owner', updated_at: 1 }];
    mount(<TermsScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'احذف CT abdomen' }));
    const dlg = await screen.findByRole('alertdialog');
    expect(within(dlg).getByText(/نص المصادر والشروح المحفوظة لا يتغير/)).toBeTruthy();
    fireEvent.click(within(dlg).getByRole('button', { name: 'احذف المصطلح' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/studybook/terms/t9')).toBe(true));
    expect(await screen.findByText('القاموس فارغ')).toBeTruthy();
  });
});

describe('RulesScreen', () => {
  const base: ExplanationRulesResponse = {
    rules: {
      rules_version: 'r-abc',
      template: 'general',
      level: 'medium',
      dialect: 'fusha_simple',
      custom_instruction: '',
      keep_english_terms: true,
      show_original_text: false,
      include: { memory_hooks: true, clinical_notes: true, exam_pearls: true, mini_questions: true, examples: true },
      socratic: false,
    },
    layers: { settings: { level: 'medium', dialect: 'fusha_simple', custom_instruction: '', socratic: false }, owner: null, node: null },
    templates: EXPLANATION_TEMPLATES,
  };
  let calls: Call[];
  beforeEach(() => {
    calls = [];
    setFetchImpl(async (url, init) => {
      const method = (init.method ?? 'GET').toUpperCase();
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
      calls.push({ method, url, body });
      if (url.startsWith('/api/library/tree')) return json({ nodes: [{ id: 'n1', parent_id: null, title: 'الجراحة', template: 'surgery', deleted_at: null, archived_at: null }], sources: [] });
      if (url.startsWith('/api/studybook/rules/owner') && method === 'PUT') {
        return json({ ...base, rules: { ...base.rules, rules_version: 'r-def', include: { ...base.rules.include, ...(body as { include?: object }).include } }, layers: { ...base.layers, owner: body } });
      }
      if (url.startsWith('/api/studybook/rules?node_id=n1')) {
        return json({ ...base, rules: { ...base.rules, template: 'surgery' }, layers: { ...base.layers, node: { node_id: 'n1', title: 'الجراحة', template_key: 'surgery', override: null } } });
      }
      if (url.startsWith('/api/studybook/rules/nodes/n1') && method === 'PUT') {
        return json({ ...base, rules: { ...base.rules, template: 'surgery', level: (body as { level?: 'expert' }).level ?? 'medium' }, layers: { ...base.layers, node: { node_id: 'n1', title: 'الجراحة', template_key: 'surgery', override: body } } });
      }
      if (url.startsWith('/api/studybook/rules')) return json(base);
      return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
    });
  });

  it('shows the effective rules with where each value comes from; saving sends only the owner layer', async () => {
    mount(<RulesScreen />, '/explanation-rules');
    expect(await screen.findByRole('heading', { name: 'القواعد المطبَّقة' })).toBeTruthy();
    expect(screen.getByText('r-abc')).toBeTruthy();
    expect(screen.getAllByText('من الإعدادات').length).toBeGreaterThan(0);
    const save = screen.getByRole('button', { name: 'احفظ القواعد' });
    expect(save).toHaveProperty('disabled', true); // nothing changed yet
    fireEvent.click(screen.getByRole('switch', { name: /وسائل حفظ/ }));
    expect(save).toHaveProperty('disabled', false);
    fireEvent.click(save);
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toBe('/api/studybook/rules/owner');
    expect(put.body).toEqual({ include: { memory_hooks: false } });
    expect(await screen.findByText('r-def')).toBeTruthy();
  });

  it('folder rules: the library template is shown, fields inherit unless set, and only set fields are sent', async () => {
    mount(<RulesScreen />, '/explanation-rules?node_id=n1');
    expect(await screen.findByRole('heading', { name: /قواعد خاصة بـ «الجراحة»/ })).toBeTruthy();
    expect(screen.getByText(/قالب المجلد في المكتبة: الجراحة/)).toBeTruthy();
    // template sections are listed with the honesty note
    expect(screen.getByText(/يُكتب القسم فقط إذا ذكرته مصادرك/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('المستوى'), { target: { value: 'expert' } });
    fireEvent.click(screen.getByRole('button', { name: 'احفظ القواعد' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toBe('/api/studybook/rules/nodes/n1');
    expect(put.body).toEqual({ level: 'expert' });
  });
});
