// AOS-2.3 / 18.3 (gaps: chunked upload into a space; templates) — the web side:
//   * lib/sha256.ts: the incremental SHA-256 the chunked upload announces (checked against Node's crypto);
//   * features/lectures/chunkedUpload.ts: a large official file goes in chunks into the SUBJECT space; when the
//     connection cuts, the same bytes are announced again and only what the server does not hold is sent; the
//     completed upload becomes the lecture's version through `{upload_id}`; a small file keeps the one-shot upload;
//   * «الشجرة»: a subject from a study template (the personal library's templates) — the names fill in, the drafts it
//     will create are listed, the server gets `template_key`, then the skeleton is created in the new space; an
//     existing subject's row creates the skeleton too.
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import type { ChannelNodeView, MeResponse, StudyTemplate } from '@medlevo/shared';
import { ToastProvider } from '../../src/design';
import { setFetchImpl } from '../../src/lib/api';
import { Sha256, sha256Hex, sha256OfBlob } from '../../src/lib/sha256';
import { chunkedUploadToSpace, uploadLectureFile } from '../../src/features/lectures/chunkedUpload';
import { routes as adminRoutes } from '../../src/features/admin/routes';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const nodeSha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
afterEach(() => setFetchImpl(null));

describe('incremental SHA-256', () => {
  it('equals Node\'s crypto for every padding boundary and for data fed in odd pieces', async () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 100_003]) {
      const data = new Uint8Array(randomBytes(n));
      expect(sha256Hex(data), `${n} bytes`).toBe(nodeSha(data));
      const h = new Sha256();
      for (let i = 0; i < n; i += 37) h.update(data.subarray(i, i + 37));
      expect(h.hex(), `${n} bytes in pieces`).toBe(nodeSha(data));
    }
    const big = new Uint8Array(randomBytes(70_001));
    expect(await sha256OfBlob(new Blob([big]), 4096)).toBe(nodeSha(big));
  });
});

describe('a chunked upload into the subject space', () => {
  it('the connection cuts mid-way: the same bytes are announced again and only the missing chunks are sent; then the lecture takes {upload_id}', async () => {
    const bytes = new Uint8Array(randomBytes(10));
    const file = new File([bytes], 'Lecture 3.pdf', { type: 'application/pdf' });
    const held = new Set<number>();
    const calls: Array<{ method: string; url: string; body: unknown; headers: Record<string, string> }> = [];
    let cut = true;
    setFetchImpl(async (url, init) => {
      const method = (init.method ?? 'GET').toUpperCase();
      const headers = (init.headers ?? {}) as Record<string, string>;
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : init.body;
      calls.push({ method, url, body, headers });
      const session = () => ({ upload_id: 'up1', status: 'open', size: 10, sha256: nodeSha(bytes), chunk_size: 4, chunks: 3, received: [...held].sort(), expires_at: 1, file_id: null });
      if (url === '/api/spaces/sp_1/uploads' && method === 'POST') return json(session());
      const c = /^\/api\/spaces\/sp_1\/uploads\/up1\/chunks\/(\d)$/.exec(url);
      if (c && method === 'PUT') {
        const n = Number(c[1]);
        if (n === 1 && cut) {
          cut = false;
          throw new TypeError('Failed to fetch'); // the phone lost its connection
        }
        const part = new Uint8Array(await (init.body as Blob).arrayBuffer());
        expect(headers['x-content-sha256']).toBe(nodeSha(part));
        expect(headers['Content-Type']).toBe('application/octet-stream');
        held.add(n);
        return json(session());
      }
      if (url === '/api/spaces/sp_1/uploads/up1/complete') return json({ file: { id: 'f1' }, deduplicated: false, session: { ...session(), status: 'completed', file_id: 'f1' } });
      if (url === '/api/spaces/sp_1/lectures/L1/upload') return json({ version_id: 'v1', job_id: 'j1' });
      return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
    });
    const progress: string[] = [];
    const oneShot = () => Promise.reject(new Error('a large file never goes in one request'));
    const res = await uploadLectureFile('sp_1', 'L1', file, { chunkedFrom: 1, retryDelayMs: 0, oneShot, onProgress: (p) => progress.push(p.stage) });
    expect(res).toEqual({ version_id: 'v1', job_id: 'j1' });
    const seq = calls.map((c) => `${c.method} ${c.url.replace('/api/spaces/sp_1', '')}`);
    expect(seq).toEqual([
      'POST /uploads',
      'PUT /uploads/up1/chunks/0',
      'PUT /uploads/up1/chunks/1', // cut
      'POST /uploads', // announced again: the same session, chunk 0 already held
      'PUT /uploads/up1/chunks/1',
      'PUT /uploads/up1/chunks/2',
      'POST /uploads/up1/complete',
      'POST /lectures/L1/upload',
    ]);
    expect(calls[0]!.body).toEqual({ size: 10, sha256: nodeSha(bytes), mime: 'application/pdf', name: 'Lecture 3.pdf', target: { space_id: 'sp_1' } });
    expect(calls.at(-1)!.body).toEqual({ upload_id: 'up1' });
    expect(progress[0]).toBe('hashing');
    expect(progress).toContain('checking');
  });

  it('what the server answered is not retried (a quota refusal is shown as it is); a small file keeps the one-shot upload', async () => {
    setFetchImpl(async () => json({ error: { code: 'QUOTA_EXCEEDED', message: 'لا توجد مساحة كافية في مادة «التشريح» لهذا الملف.' } }, 409));
    const file = new File([new Uint8Array(20)], 'big.pdf', { type: 'application/pdf' });
    await expect(chunkedUploadToSpace('sp_1', file, { retryDelayMs: 0 })).rejects.toThrow('لا توجد مساحة كافية في مادة «التشريح» لهذا الملف.');
    let oneShotCalls = 0;
    const r = await uploadLectureFile('sp_1', 'L1', file, { oneShot: async () => (oneShotCalls++, { version_id: 'v', job_id: 'j' }) });
    expect(r.version_id).toBe('v');
    expect(oneShotCalls).toBe(1);
  });
});

// ───────── «الشجرة»: subjects and lecture skeletons from a study template ─────────

const ME = { id: 'me', username: 'me', display_name: 'أنا', is_platform_admin: false, vault_id: 'v', timezone: 'Asia/Baghdad', memberships: [], roles: [], quota: null, legacy_owner: false } as unknown as MeResponse;
function node(id: string, kind: string, title: string, parent: string | null, titleEn: string | null = null): ChannelNodeView {
  return {
    id,
    kind,
    title,
    parent_id: parent,
    title_en: titleEn,
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
const PHYS = node('phys', 'subject', 'الفسلجة', 'u1');
const TEMPLATES: StudyTemplate[] = [
  {
    key: 'anatomy',
    title_ar: 'التشريح',
    title_en: 'Anatomy',
    description_ar: 'مقسّم حسب مناطق الجسم.',
    explanation_template: 'anatomical',
    cover: { style: 'linen', color: 'rose', symbol: 'bone' },
    icon: 'bone',
    skeleton: [
      { title: 'المحاضرات', kind: 'folder' },
      { title: 'الطرف العلوي — Upper limb', kind: 'topic_folder' },
      { title: 'الصدر — Thorax', kind: 'topic_folder' },
    ],
  } as StudyTemplate,
];

let calls: Array<{ method: string; url: string; body: unknown }> = [];
function serve() {
  calls = [];
  setFetchImpl(async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, url, body });
    const path = url.split('?')[0]!;
    if (path === '/api/accounts/me') return json(ME);
    if (path === '/api/channels/tree') return json({ nodes: [U, PHYS], truncated: false });
    if (path === '/api/library/templates') return json({ templates: TEMPLATES });
    if (path === '/api/channels/nodes' && method === 'POST') {
      const b = body as { title: string; title_en?: string };
      return json(node('anat', 'subject', b.title, 'u1', b.title_en ?? null));
    }
    const t = /^\/api\/spaces\/([^/]+)\/lectures\/from-template$/.exec(path);
    if (t && method === 'POST') return json({ created: [{ id: 'l1', title: 'الطرف العلوي — Upper limb' }, { id: 'l2', title: 'الصدر — Thorax' }], skipped: [] });
    return json({ error: { code: 'NOT_FOUND', message: 'المسار المطلوب غير موجود.' } }, 404);
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

describe('«الشجرة» — a subject from a study template', () => {
  it('choosing a template fills the names and lists the drafts; «أنشئ» sends template_key, then creates the skeleton in the new space', async () => {
    serve();
    show('/admin/tree?node=u1');
    fireEvent.click(await screen.findByRole('button', { name: 'أضف تحت جامعة بغداد' }));
    const dialog = await screen.findByRole('dialog', { name: 'عقدة جديدة تحت جامعة بغداد' });
    fireEvent.change(within(dialog).getByLabelText('النوع'), { target: { value: 'subject' } });
    const pick = (await within(dialog).findByLabelText('قالب الدراسة (اختياري)')) as HTMLSelectElement;
    expect([...pick.options].map((o) => o.textContent)).toEqual(['بلا قالب', 'التشريح']);
    fireEvent.change(pick, { target: { value: 'anatomy' } });
    expect((within(dialog).getByLabelText('الاسم') as HTMLInputElement).value).toBe('التشريح');
    expect((within(dialog).getByLabelText('الاسم الإنجليزي (اختياري)') as HTMLInputElement).value).toBe('Anatomy');
    // the drafts it will create: the topics, not the library's container folders
    const preview = within(dialog).getByText(/مسودات المحاضرات التي تُنشأ \(2\)/);
    expect(preview.textContent).toContain('الطرف العلوي — Upper limb');
    expect(preview.textContent).toContain('الصدر — Thorax');
    expect(preview.textContent).not.toContain('المحاضرات،');
    fireEvent.click(within(dialog).getByRole('button', { name: 'أنشئ' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/spaces/sp_anat/lectures/from-template')).toBe(true));
    const created = calls.find((c) => c.method === 'POST' && c.url === '/api/channels/nodes')!.body;
    expect(created).toMatchObject({ parent_id: 'u1', kind: 'subject', title: 'التشريح', title_en: 'Anatomy', template_key: 'anatomy', create_space: true });
    expect(calls.find((c) => c.url === '/api/spaces/sp_anat/lectures/from-template')!.body).toEqual({ template_key: 'anatomy' });
    expect(await screen.findByText('أُنشئت «التشريح». أُضيفت مسودتا محاضرتين.')).toBeTruthy();
  });

  it('without a template nothing more is sent; an existing subject\'s row creates its skeleton', async () => {
    serve();
    show('/admin/tree?node=u1');
    fireEvent.click(await screen.findByRole('button', { name: 'مسودات محاضرات من قالب لـ الفسلجة' }));
    const dialog = await screen.findByRole('dialog', { name: 'مسودات محاضرات من قالب — الفسلجة' });
    const go = within(dialog).getByRole('button', { name: /أنشئ المسودات/ });
    fireEvent.click(go); // no template chosen yet: the button says why and sends nothing
    expect(calls.some((c) => c.url.endsWith('/lectures/from-template'))).toBe(false);
    fireEvent.change(await within(dialog).findByLabelText('قالب الدراسة'), { target: { value: 'anatomy' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /أنشئ المسودات/ }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/spaces/sp_phys/lectures/from-template')).toBe(true));
    expect(await screen.findByText('أُضيفت مسودتا محاضرتين.')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/channels/nodes')).toBe(false);
  });
});
