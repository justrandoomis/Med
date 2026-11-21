// Phase 1 completion — «انشرها كمحاضرة رسمية» (AOS-19H.4, X8 (c)): the library row menu of the viewer's OWN private
// lecture offers it only when the viewer moderates a subject (Subject Moderator / Admin there, or the platform admin);
// nobody else sees the control. Choosing the subject and confirming calls POST /api/spaces/:s/lectures/from-vault and
// the result says what was created (a draft students do not see) — or the server's reason when it is refused.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelNodeView, ChannelRole, LectureFromVaultResponse, OfficialLinkStatus, SourceSummary } from '@medlevo/shared';
import { Menu, ToastProvider } from '../../design';
import { api, ApiError } from '../../lib/api';
import { resetLinkStatusCache } from './linkStatus';
import { resetPublishTargets, usePublishToOfficialAction } from './publishToOfficial';

const subject = (id: string, title: string, spaceId: string, roles: ChannelRole[]): ChannelNodeView =>
  ({
    id,
    kind: 'subject',
    title,
    parent_id: 'COURSE',
    title_en: null,
    ordinal: null,
    starts_on: null,
    ends_on: null,
    has_space: true,
    space_id: spaceId,
    join_policy: 'approval',
    status: 'active',
    viewer: { membership: null, roles, inherited_from: null, course_follow: null },
  }) as unknown as ChannelNodeView;

const SOURCE = { id: 'MINE', title: 'Histology lab', source_type: 'lecture', active_version_id: 'V1', deleted_at: null } as Pick<
  SourceSummary,
  'id' | 'title' | 'source_type' | 'active_version_id' | 'deleted_at'
>;
const status = (o: Partial<OfficialLinkStatus> & { source_id: string }): OfficialLinkStatus => ({ official: null, linked: null, candidate: null, ...o });

let tree: ChannelNodeView[];
let platformAdmin: boolean;
let linkStatus: OfficialLinkStatus;
let gets: string[];
beforeEach(() => {
  vi.restoreAllMocks();
  resetLinkStatusCache();
  resetPublishTargets();
  platformAdmin = false;
  linkStatus = status({ source_id: 'MINE' });
  gets = [];
  tree = [];
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    gets.push(path);
    if (path === '/copies/link-status') return { statuses: [linkStatus] };
    if (path === '/channels/tree') return { nodes: tree, truncated: false };
    if (path === '/accounts/me') return { is_platform_admin: platformAdmin };
    throw new Error(`unexpected ${path}`);
  });
});

function Host({ source = SOURCE }: { source?: typeof SOURCE }) {
  const a = usePublishToOfficialAction(source);
  return (
    <>
      <Menu trigger={<button type="button">خيارات</button>}>{a.item ?? <span>لا شيء</span>}</Menu>
      {a.dialog}
    </>
  );
}
const mount = (source?: typeof SOURCE) =>
  render(
    <MemoryRouter>
      <ToastProvider>
        <Host source={source} />
      </ToastProvider>
    </MemoryRouter>,
  );
const settle = async () => {
  await waitFor(() => expect(gets).toEqual(expect.arrayContaining(['/copies/link-status', '/channels/tree', '/accounts/me'])));
  await act(async () => new Promise((r) => setTimeout(r, 10)));
};
const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'خيارات' }));
const ITEM = { name: 'انشرها كمحاضرة رسمية…' };

describe('who sees «انشرها كمحاضرة رسمية…»', () => {
  it('a member, a Contributor or an Assistant (no Subject Moderator role anywhere) sees no such control', async () => {
    tree = [subject('S1', 'التشريح', 'SPA', []), subject('S2', 'الفسلجة', 'SPB', ['contributor']), subject('S3', 'الكيمياء', 'SPC', ['assistant'])];
    mount();
    await settle();
    openMenu();
    expect(screen.queryByRole('menuitem', ITEM)).toBeNull();
  });

  it('a Subject Moderator sees it on their own private lecture — not on an official copy, a linked lecture or a non-lecture', async () => {
    tree = [subject('S1', 'التشريح', 'SPA', ['subject_moderator'])];
    const first = mount();
    await settle();
    openMenu();
    expect(await screen.findByRole('menuitem', ITEM)).toBeTruthy();
    first.unmount();

    for (const s of [status({ source_id: 'MINE', official: { space_id: 'SPA', lecture_id: 'L1', subject_title: 'التشريح' } }), status({ source_id: 'MINE', linked: { stub_source_id: 'STUB', space_id: 'SPA', lecture_id: 'L1', subject_title: 'التشريح', pending: 0 } })]) {
      resetLinkStatusCache();
      linkStatus = s;
      const r = mount();
      await settle();
      openMenu();
      expect(screen.queryByRole('menuitem', ITEM)).toBeNull();
      r.unmount();
    }
    resetLinkStatusCache();
    linkStatus = status({ source_id: 'NOTES' });
    mount({ ...SOURCE, id: 'NOTES', source_type: 'my_notes' });
    await settle();
    openMenu();
    expect(screen.queryByRole('menuitem', ITEM)).toBeNull();
  });
});

describe('publishing', () => {
  it('only the subjects the viewer moderates are offered; confirming calls from-vault and the result is honest', async () => {
    tree = [subject('S1', 'التشريح', 'SPA', ['subject_moderator']), subject('S2', 'الفسلجة', 'SPB', ['contributor']), subject('S3', 'الأنسجة', 'SPC', ['admin'])];
    const posts: Array<{ path: string; body: unknown }> = [];
    vi.spyOn(api, 'post').mockImplementation(async (path: string, body?: unknown) => {
      posts.push({ path, body });
      return {
        lecture: { id: 'OL1', space_id: 'SPC', title: 'Histology lab', lecture_no: 7, status: 'draft' },
        version_id: 'OV1',
        job_id: 'J1',
      } as unknown as LectureFromVaultResponse;
    });
    mount();
    await settle();
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', ITEM));
    const dialog = await screen.findByRole('dialog', { name: 'انشرها كمحاضرة رسمية' });
    const select = within(dialog).getByLabelText('المادة') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['الأنسجة', 'التشريح']);
    fireEvent.change(select, { target: { value: 'S3' } });
    expect((within(dialog).getByLabelText(/عنوان المحاضرة الرسمية/) as HTMLInputElement).value).toBe('Histology lab');
    fireEvent.change(within(dialog).getByLabelText(/رقم المحاضرة/), { target: { value: '7' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'أنشئ المسودة الرسمية' }));
    const done = await screen.findByRole('dialog', { name: 'أُنشئت مسودة المحاضرة الرسمية' });
    expect(posts).toEqual([{ path: '/spaces/SPC/lectures/from-vault', body: { source_id: 'MINE', title: 'Histology lab', lecture_no: 7 } }]);
    expect(done.textContent).toContain('مسودة');
    expect(done.textContent).toContain('الأنسجة');
    expect(done.textContent).toContain('لا يراها الطلاب بعد');
    expect(done.textContent).toContain('ملفك الخاص وكل ما كتبته عليه بقي في مكتبتك');
    expect(within(done).getByRole('button', { name: 'افتح «المحتوى الرسمي»' })).toBeTruthy();
  });

  it('the platform admin may publish into every subject they can bind', async () => {
    platformAdmin = true;
    tree = [subject('S1', 'التشريح', 'SPA', [])];
    mount();
    await settle();
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', ITEM));
    const dialog = await screen.findByRole('dialog', { name: 'انشرها كمحاضرة رسمية' });
    expect(dialog.textContent).toContain('المادة: التشريح');
  });

  it('a refusal shows the server’s reason and no result', async () => {
    tree = [subject('S1', 'التشريح', 'SPA', ['subject_moderator'])];
    vi.spyOn(api, 'post').mockRejectedValue(new ApiError({ code: 'QUOTA_EXCEEDED', status: 409, message: 'امتلأت مساحة مادة التشريح.' }));
    mount();
    await settle();
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', ITEM));
    const dialog = await screen.findByRole('dialog', { name: 'انشرها كمحاضرة رسمية' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'أنشئ المسودة الرسمية' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('امتلأت مساحة مادة التشريح.');
    expect(screen.queryByRole('dialog', { name: 'أُنشئت مسودة المحاضرة الرسمية' })).toBeNull();
  });
});
