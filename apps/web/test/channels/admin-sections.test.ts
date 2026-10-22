// Wave-2 step 0 — the «إدارة القنوات» section registry (BUILD_PLAN §3.2: `features/admin/sections.ts` is P1-T4's; P1-T5
// registers «المحتوى الرسمي» and «الملفات المكررة» from its own `features/lectures/admin/*`). The registry starts
// empty, so nothing is shown until a track registers a built screen (AOS-23.3: no decorative controls). Which roles see
// a section is decided here, once, from IA_AND_JOURNEYS §4.10 and the PRD §4.3 matrix; the server still decides every
// action.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelRole } from '@medlevo/shared';

type Mod = typeof import('../../src/features/admin/sections');
let m: Mod;
beforeEach(async () => {
  vi.resetModules();
  m = await import('../../src/features/admin/sections');
});

const Screen = () => null;
const lazy = async () => ({ Component: Screen });

describe('admin section registry', () => {
  it('plans the Phase 1 sections of IA §4.10 with their owning track, in order, and registers none yet', () => {
    expect(Object.entries(m.ADMIN_SECTION_PLAN).map(([id, p]) => [id, p.owner, p.title_ar])).toEqual([
      ['tree', 'P1-T4', 'الشجرة'],
      ['members', 'P1-T4', 'الأعضاء وطلبات الانضمام'],
      ['codes', 'P1-T4', 'الرموز والدعوات'],
      ['roles', 'P1-T4', 'الأدوار'],
      ['official', 'P1-T5', 'المحتوى الرسمي'],
      ['duplicates', 'P1-T5', 'الملفات المكررة'],
      ['moderation', 'P1-T4', 'الإشراف'],
      // IA §4.10 «الملفات والمواعيد» (Phase 1: approving contributors' attachments) — planned for P1-T5 so it never
      // has to edit this file (review W2-step0 R10)
      ['files', 'P1-T5', 'الملفات والمواعيد'],
      ['audit', 'P1-T4', 'سجل الإجراءات'],
    ]);
    const orders = Object.values(m.ADMIN_SECTION_PLAN).map((p) => p.order);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
    expect(m.adminSections()).toEqual([]);
    expect(m.visibleAdminSections({ roles: ['admin'], isPlatformAdmin: true })).toEqual([]);
  });

  it('registers a section with the plan’s title, order, roles and path; lists sections in plan order', () => {
    m.registerAdminSection({ id: 'audit', owner: 'P1-T4', description_ar: 'سجل الإجراءات في نطاقك', lazy });
    const official = m.registerAdminSection({ id: 'official', owner: 'P1-T5', description_ar: 'مسودات بانتظار الموافقة والإصدارات', lazy });
    expect(official).toMatchObject({ id: 'official', title_ar: 'المحتوى الرسمي', order: m.ADMIN_SECTION_PLAN.official.order, path: '/admin/official' });
    expect(m.adminSections().map((s) => s.id)).toEqual(['official', 'audit']);
  });

  it('refuses a duplicate, an unplanned id, the other track’s section and a description without Arabic', () => {
    m.registerAdminSection({ id: 'tree', owner: 'P1-T4', description_ar: 'إنشاء العقد وتعديلها', lazy });
    expect(() => m.registerAdminSection({ id: 'tree', owner: 'P1-T4', description_ar: 'مرة ثانية', lazy })).toThrow(/already registered/);
    expect(() => m.registerAdminSection({ id: 'stats' as never, owner: 'P1-T4', description_ar: 'الإحصاءات', lazy })).toThrow(/not planned/);
    expect(() => m.registerAdminSection({ id: 'official', owner: 'P1-T4', description_ar: 'المحتوى', lazy })).toThrow(/owned by P1-T5/);
    expect(() => m.registerAdminSection({ id: 'roles', owner: 'P1-T4', description_ar: 'roles', lazy })).toThrow(/Arabic/);
  });

  it('shows a section only to the roles the plan names; the platform admin sees every registered section', () => {
    for (const id of Object.keys(m.ADMIN_SECTION_PLAN) as Array<keyof Mod['ADMIN_SECTION_PLAN']>) {
      m.registerAdminSection({ id, owner: m.ADMIN_SECTION_PLAN[id].owner, description_ar: 'وصف القسم', lazy });
    }
    const ids = (roles: ChannelRole[], isPlatformAdmin = false) => m.visibleAdminSections({ roles, isPlatformAdmin }).map((s) => s.id);
    expect(ids([])).toEqual([]);
    expect(ids([], true)).toEqual(Object.keys(m.ADMIN_SECTION_PLAN));
    expect(ids(['admin'])).toEqual(Object.keys(m.ADMIN_SECTION_PLAN));
    // an assistant approves joins, manages codes and moderates; no tree, roles or official uploads (PRD §4.3)
    expect(ids(['assistant'])).toEqual(['members', 'codes', 'moderation', 'audit']);
    // a subject moderator: official content, duplicates, moderation, attachments — joins are approved by Admins and
    // Assistants
    expect(ids(['subject_moderator'])).toEqual(['official', 'duplicates', 'moderation', 'files']);
    // a contributor sees the official content (its own drafts) only
    expect(ids(['contributor'])).toEqual(['official']);
  });
});
