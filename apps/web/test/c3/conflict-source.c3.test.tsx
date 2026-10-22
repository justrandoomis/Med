// AOS-20.19 (track C3): conflicts say whether the newer copy came from «جهاز آخر لك» (the same account, another of
// its devices) or «مستخدم آخر» (another person). Before C3 every conflict said «جهاز آخر» — even when another admin had
// decided a join request first — and none said which.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import type { ChannelNodeView, MeResponse, MemberView, StudyLocation } from '@medlevo/shared';
import { ToastProvider } from '../../src/design';
import { setFetchImpl } from '../../src/lib/api';
import { decidedElsewhereAr, syncConflictSource, VAULT_CONFLICT_COPY_AR } from '../../src/lib/conflictSource';
import { describeSyncIssue } from '../../src/features/control/model';
import { RemoteMoveBanner, SessionConflictDialog } from '../../src/features/workspace/session/SessionPrompts';
import { describeSyncSnapshot } from '../../src/lib/sync';
import { routes as adminRoutes } from '../../src/features/admin/routes';

const base = { op_id: 'o', entity_id: 'e', op: 'upsert' as const, base_rev: 3, payload: null, client_ts: 1, attempts: 1, nextAttemptAt: 0 };

describe('AOS-20.19 — where a conflict came from', () => {
  it('an op of the account’s own vault: «جهاز آخر لك» (the vault has one writer — its user)', () => {
    expect(syncConflictSource({}, 'u1')).toBe('own_device');
    expect(syncConflictSource({ target: 'vault', resultEntity: { author_user_id: 'u1' } }, 'u1')).toBe('own_device');
    const kept = describeSyncIssue({ ...base, entity_type: 'note', status: 'conflict', result: 'conflict_kept_both' }, 'u1');
    expect(kept.happened).toContain('جهاز آخر لك');
    expect(kept.happened).not.toContain('مستخدم آخر');
    const refused = describeSyncIssue({ ...base, entity_type: 'study_session', status: 'conflict', result: 'rejected' }, 'u1');
    expect(refused.happened).toContain('جهاز آخر لك');
  });

  it('an op of a subject space, the newer copy written by someone else: «مستخدم آخر»; by this account: «جهاز آخر لك»', () => {
    expect(syncConflictSource({ target: 'space:S1', resultEntity: { updated_by: 'u2' } }, 'u1')).toBe('other_user');
    expect(syncConflictSource({ target: 'space:S1', resultEntity: { updated_by: { id: 'u1' } } }, 'u1')).toBe('own_device');
    // a space record that does not say who wrote it is never claimed to be this account's
    expect(syncConflictSource({ target: 'space:S1', resultEntity: {} }, 'u1')).toBe('other_user');
    const other = describeSyncIssue({ ...base, target: 'space:S1', entity_type: 'note', status: 'conflict', result: 'conflict_kept_both', resultEntity: { updated_by: 'u2' } }, 'u1');
    expect(other.happened).toContain('مستخدم آخر');
    expect(other.happened).not.toContain('جهاز آخر لك');
  });

  it('the study-session prompts name «جهاز آخر لك»', () => {
    const loc: StudyLocation = { page_index: 2 } as StudyLocation;
    render(
      <SessionConflictDialog
        open
        theirs={{ location: loc, versionId: null, updatedAt: 1_800_000_000_000 }}
        mine={{ location: { page_index: 0 } as StudyLocation }}
        pages={[]}
        versions={[]}
        currentVersionId="v1"
        onTheirs={() => undefined}
        onMine={() => undefined}
      />,
    );
    expect(screen.getByRole('dialog', { name: 'موضع أحدث من جهاز آخر لك' })).toBeTruthy();
    expect(screen.getByText(/على جهاز آخر لك وصلت إلى/)).toBeTruthy();
  });

  it('the «opened elsewhere» banner names «جهاز آخر لك»', () => {
    render(<RemoteMoveBanner label="ص 3" onGo={() => undefined} onDismiss={() => undefined} />);
    expect(screen.getByRole('status').textContent).toContain('فُتح هذا المصدر على جهاز آخر لك عند ص 3');
  });

  it('the save indicator, the kept note copy, the card editor and the undo check say «جهاز آخر لك»', () => {
    const line = describeSyncSnapshot({ pending: 0, conflicts: 2, errors: 0, online: true, authRequired: false, pullFailed: false, lastError: null, lastSyncedAt: 1 } as Parameters<typeof describeSyncSnapshot>[0]);
    expect(line).toContain('جهاز آخر لك');
    expect(VAULT_CONFLICT_COPY_AR).toBe('نسخة محفوظة من تعارض مع جهاز آخر لك');
    const src = (p: string) => readFileSync(join(__dirname, '../../src', p), 'utf8');
    expect(src('features/workspace/panels/MineTab.tsx')).toContain('VAULT_CONFLICT_COPY_AR');
    for (const file of ['features/review/CardEditor.tsx', 'features/workspace/ink/InkProvider.tsx']) {
      const text = src(file);
      // every «جهاز آخر» in these conflict texts is the account's own other device
      expect(text.match(/جهاز آخر(?! لك)/g) ?? [], file).toEqual([]);
    }
  });
});

// ───────── a decision another person took first (a real multi-writer path of Phase 1) ─────────

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const user = (id: string, name: string) => ({ id, display_name: name, avatar_url: null });
const ME: MeResponse = { id: 'me', username: 'me', display_name: 'أنا', is_platform_admin: false, vault_id: 'v', timezone: 'Asia/Baghdad', memberships: [], roles: [], quota: null, legacy_owner: false } as unknown as MeResponse;
const ANAT = {
  id: 'anat',
  kind: 'subject',
  title: 'Anatomy',
  parent_id: null,
  title_en: null,
  ordinal: null,
  starts_on: null,
  ends_on: null,
  has_space: true,
  space_id: 'sp_anat',
  join_policy: 'approval',
  status: 'active',
  viewer: { membership: null, roles: ['admin'], inherited_from: null, course_follow: null },
} as unknown as ChannelNodeView;

function member(decidedBy: ReturnType<typeof user> | null, status: MemberView['status']): MemberView {
  return { membership_id: 'm1', user: user('stu', 'هدى'), status, join_method: 'class_code', created_at: 1, decided_at: decidedBy ? 2 : null, decided_by: decidedBy, reason_ar: null, roles: [] };
}

function serveMembers(decidedBy: ReturnType<typeof user>) {
  let decided = false;
  setFetchImpl(async (url, init) => {
    const method = init?.method ?? 'GET';
    const path = url.split('?')[0]!;
    if (path === '/api/accounts/me') return json(ME);
    if (path === '/api/channels/tree') return json({ nodes: [ANAT], truncated: false });
    if (path === '/api/channels/nodes/anat/members' && method === 'GET') {
      const status = new URL(url, 'http://x').searchParams.get('status');
      if (!decided) return json({ items: status === 'pending' ? [member(null, 'pending')] : [], next_cursor: null });
      return json({ items: status === 'approved' ? [member(decidedBy, 'approved')] : [], next_cursor: null });
    }
    if (path === '/api/channels/nodes/anat/members/stu/decision') {
      decided = true;
      return json({ error: { code: 'CONFLICT', message: 'لا ينطبق هذا القرار على حالة العضوية الحالية.', details: { status: 'approved' } } }, 409);
    }
    return json({ error: { code: 'NOT_FOUND', message: 'المسار المطلوب غير موجود.' } }, 404);
  });
}

function showMembers() {
  const router = createMemoryRouter([{ path: '/', children: [...(adminRoutes.shell ?? [])] }], { initialEntries: ['/admin/members?node=anat'] });
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

describe('AOS-20.19 — «الأعضاء وطلبات الانضمام»: a request someone decided first', () => {
  it('another admin approved it first: «مستخدم آخر», named', async () => {
    serveMembers(user('admin2', 'د. سلمى'));
    showMembers();
    const row = await screen.findByText('هدى');
    const li = row.closest('li')!;
    fireEvent.click(within(li as HTMLElement).getByRole('button', { name: 'وافق على هدى' }));
    await waitFor(() => expect(screen.getByText(/سبقك مستخدم آخر: قرّر «د. سلمى» هذا الطلب قبلك/)).toBeTruthy());
    expect(decidedElsewhereAr(user('admin2', 'د. سلمى'), 'me')).toContain('مستخدم آخر');
  });

  it('this account approved it on another device: «جهاز آخر لك»', async () => {
    serveMembers(user('me', 'أنا'));
    showMembers();
    const row = await screen.findByText('هدى');
    fireEvent.click(within(row.closest('li') as HTMLElement).getByRole('button', { name: 'وافق على هدى' }));
    // (review R5) the record names the account, not the device: «من هذا الجهاز أو من جهاز آخر لك»
    await waitFor(() => expect(screen.getByText(/قرّرتَ هذا الطلب قبل قليل \(من هذا الجهاز أو من جهاز آخر لك\)/)).toBeTruthy());
  });
});
