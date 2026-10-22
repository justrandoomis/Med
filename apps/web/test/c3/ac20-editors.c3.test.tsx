// AOS-1.16 / AOS-20.3 (track C3): AC-20 on every NEW editor — channel and subject titles, lecture titles, explanation
// titles and summaries, change notes, reasons, the display name. A bidi control character (pasted unseen from
// WhatsApp, Word or a PDF viewer) is removed as the person types or pastes, so it is never sent and never stored; the
// field shows exactly what will be stored. Before C3 these editors sent the raw text and the server refused it with
// «… يحتوي محارف تحكم في الاتجاه؛ احذفها» — characters the person cannot see, so cannot delete.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import type { ChannelNodeView, MeResponse, MemberView } from '@medlevo/shared';
import { ToastProvider } from '../../src/design';
import { setFetchImpl } from '../../src/lib/api';
import { cleanTyped } from '../../src/lib/typedText';
import { MixedText, firstStrongDir } from '../../src/lib/MixedText';
import { routes as adminRoutes } from '../../src/features/admin/routes';

const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
/** what a pasted title looks like: RLE … PDF around the English, an RLM, an isolate, a line break */
const PASTED = 'التشريح \u202BAnatomy 101\u202C \u200F(CT abdomen)\u2066 ×10⁹\u2069';
const CLEAN = 'التشريح Anatomy 101 (CT abdomen) ×10⁹';

describe('cleanTyped', () => {
  it('removes every bidi control and invisible control; keeps the text, its order and line breaks where they belong', () => {
    expect(cleanTyped(PASTED)).toBe(CLEAN);
    expect(BIDI.test(cleanTyped(PASTED))).toBe(false);
    expect(cleanTyped('سطر\u061C أول\nسطر ثانٍ')).toBe('سطر أول سطر ثانٍ');
    expect(cleanTyped('سطر أول\nسطر\u200E ثانٍ\u0007', { multiline: true })).toBe('سطر أول\nسطر ثانٍ');
    // Arabic, English, digits, super/subscripts and symbols are never touched
    const mixed = 'عدد الكريات 11 ×10⁹ وCO₂ وHCO₃⁻ و Na+ 135 mmol/L و A → B';
    expect(cleanTyped(mixed)).toBe(mixed);
  });
});

/** Every text editor of the Academic OS screens (one line or multi-line) and the files they live in. */
const NEW_EDITORS = [
  'features/admin/TreeSection.tsx',
  'features/admin/MembersSection.tsx',
  'features/lectures/PublicationScreen.tsx',
  'features/lectures/PublishDialog.tsx',
  'features/lectures/ReportDialog.tsx',
  'features/lectures/admin/OfficialContentSection.tsx',
  'features/channels/JoinLinkScreen.tsx',
];

describe('every new editor removes bidi controls as the person types', () => {
  it('no TextField / TextArea of the new screens stores e.target.value raw (dates, numbers and codes excepted)', () => {
    const raw: string[] = [];
    for (const file of NEW_EDITORS) {
      const src = readFileSync(join(__dirname, '../../src', file), 'utf8');
      for (const m of src.matchAll(/<(TextField|TextArea)\b[\s\S]*?\/>/g)) {
        const tag = m[0];
        // dates, numbers and the login name (an identifier with its own rules, not text others read)
        if (/type="date"|inputMode="numeric"|autoComplete="username"/.test(tag)) continue;
        if (/onChange=\{\(e\) => set\w*\(e\.target\.value\)\}/.test(tag) || /onChange=\{set\('/.test(tag)) raw.push(`${file}: ${tag.slice(0, 90)}`);
      }
    }
    expect(raw, raw.join('\n')).toEqual([]);
  });
});

// ───────── render: the tree's «add» dialog and the reason dialog (members + moderation share it) ─────────

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ME: MeResponse = { id: 'me', username: 'me', display_name: 'أنا', is_platform_admin: false, vault_id: 'v', timezone: 'Asia/Baghdad', memberships: [], roles: [], quota: null, legacy_owner: false } as unknown as MeResponse;
function node(id: string, kind: string, title: string, parent: string | null): ChannelNodeView {
  return {
    id,
    kind,
    title,
    parent_id: parent,
    title_en: null,
    ordinal: null,
    starts_on: null,
    ends_on: null,
    has_space: kind === 'subject',
    space_id: kind === 'subject' ? `sp_${id}` : null,
    join_policy: 'approval',
    status: 'active',
    viewer: { membership: null, roles: ['admin'], inherited_from: null, course_follow: null },
  } as unknown as ChannelNodeView;
}
const U = node('u1', 'university', 'جامعة بغداد', null);
const ANAT = node('anat', 'subject', 'Anatomy', 'u1');

let calls: Array<{ method: string; url: string; body: unknown }> = [];
function serve(extra: Record<string, (method: string, body: unknown, url: string) => Response>) {
  calls = [];
  setFetchImpl(async (url, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const path = url.split('?')[0]!;
    if (path === '/api/accounts/me') return json(ME);
    if (path === '/api/channels/tree') return json({ nodes: [U, ANAT], truncated: false });
    const hit = extra[path];
    return hit ? hit(method, body, url) : json({ error: { code: 'NOT_FOUND', message: 'المسار المطلوب غير موجود.' } }, 404);
  });
}
function show(path: string) {
  const router = createMemoryRouter([{ path: '/', children: [...(adminRoutes.shell ?? [])] }], { initialEntries: [path] });
  render(
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>,
  );
}
beforeAll(async () => {
  await import('../../src/features/admin/register');
});
afterEach(() => setFetchImpl(null));

describe('render', () => {
  it('«الشجرة» — a pasted title: the field shows it without controls and the server receives it clean', async () => {
    serve({ '/api/channels/nodes': (m, body) => (m === 'POST' ? json({ ...node('n2', 'college', (body as { title: string }).title, 'u1') }) : json({}, 405)) });
    show('/admin/tree?node=u1');
    fireEvent.click(await screen.findByRole('button', { name: 'أضف تحت جامعة بغداد' }));
    const dialog = await screen.findByRole('dialog', { name: 'عقدة جديدة تحت جامعة بغداد' });
    const title = within(dialog).getByLabelText('الاسم') as HTMLInputElement;
    fireEvent.change(title, { target: { value: PASTED } });
    expect(title.value).toBe(CLEAN);
    fireEvent.change(within(dialog).getByLabelText('الاسم الإنجليزي (اختياري)'), { target: { value: '\u202AAnatomy\u202C' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'أنشئ' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.startsWith('/api/channels/nodes'))).toBe(true));
    const sent = calls.find((c) => c.method === 'POST')!.body as { title: string; title_en?: string };
    expect(sent.title).toBe(CLEAN);
    expect(sent.title_en).toBe('Anatomy');
    expect(BIDI.test(JSON.stringify(sent))).toBe(false);
  });

  it('a reason (reject a join request; «الإشراف» uses the same dialog): sent without controls', async () => {
    const m: MemberView = { membership_id: 'm1', user: { id: 'stu', display_name: 'هدى', avatar_url: null }, status: 'pending', join_method: 'class_code', created_at: 1, decided_at: null, decided_by: null, reason_ar: null, roles: [] };
    serve({
      '/api/channels/nodes/anat/members': () => json({ items: [m], next_cursor: null }),
      '/api/channels/nodes/anat/members/stu/decision': () => json({ ...m, status: 'rejected' }),
    });
    show('/admin/members?node=anat');
    const li = (await screen.findByText('هدى')).closest('li') as HTMLElement;
    fireEvent.click(within(li).getByRole('button', { name: /ارفض/ }));
    const dialog = await screen.findByRole('dialog');
    const box = within(dialog).getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'الرمز \u200Fمنتهي\u200F — expired \u2067code\u2069\nأعد الطلب' } });
    expect(box.value).toBe('الرمز منتهي — expired code\nأعد الطلب');
    fireEvent.click(within(dialog).getAllByRole('button').find((b) => /ارفض/.test(b.textContent ?? ''))!);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/decision'))).toBe(true));
    const sent = calls.find((c) => c.url.endsWith('/decision'))!.body as { reason?: string };
    expect(sent.reason).toBe('الرمز منتهي — expired code\nأعد الطلب');
  });
});

// Drawn where people read it: a title typed by a person keeps the direction of its first letter (like <bdi>, HTML
// dir=auto) and every English expression — with the brackets around it — is isolated. A plain <bdi>{title}</bdi>
// left «(CT abdomen)» after an Arabic word to the bidi algorithm, which drew the «(» on the wrong side (found by
// e2e/aos-c3-ac20-new-screens.spec.ts on the publication heading).
describe('MixedText', () => {
  it('direction from the first strong letter; the LTR expressions, brackets included, are isolated in <bdi dir="ltr">', () => {
    expect(firstStrongDir('شرح Anatomy 101 (CT abdomen) abc def ghi')).toBe('rtl');
    expect(firstStrongDir('(CT) Anatomy شرح')).toBe('ltr');
    expect(firstStrongDir('101 — ×10⁹')).toBe('rtl');
    const { container } = render(<h1><MixedText text="شرح Anatomy 101 للكلية عن البطن (CT abdomen) jk84" /></h1>);
    const span = container.querySelector('h1 > span')!;
    expect(span.getAttribute('dir')).toBe('rtl');
    expect(span.textContent).toBe('شرح Anatomy 101 للكلية عن البطن (CT abdomen) jk84');
    const islands = [...span.querySelectorAll('bdi[dir="ltr"]')].map((b) => b.textContent);
    expect(islands).toEqual(['Anatomy 101', '(CT abdomen) jk84']);
    expect(BIDI.test(container.innerHTML)).toBe(false);
  });
});
