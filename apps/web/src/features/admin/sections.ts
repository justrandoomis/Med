// «إدارة القنوات» — the section registry of the channel administration area (`/admin/…`; IA_AND_JOURNEYS §4.10,
// BUILD_PLAN §3.2). P1-T4 owns this file and the area; each track registers its OWN sections from its own feature
// folder (P1-T5: «المحتوى الرسمي», «الملفات المكررة» and «الملفات والمواعيد» from `features/lectures/admin/*`), so
// neither track edits the other's screens.
//
// Wave-2 step 0: the plan below names every Phase 1 section, its owner, its place and who sees it; the registry starts
// EMPTY and a section appears only once its track registers a built screen (AOS-23.3 — no decorative entries, nothing
// of a later phase: «الإحصاءات» is Phase 2 and is not planned here). Who SEES a section is a convenience for the menu;
// the server still decides every action (404 for anything the viewer may not see, 403 for what they may not do).
import type { ComponentType } from 'react';
import type { ChannelRole } from '@medlevo/shared';

export type AdminSectionOwner = 'P1-T4' | 'P1-T5';

interface AdminSectionPlan {
  owner: AdminSectionOwner;
  /** position in the area's index */
  order: number;
  title_ar: string;
  /** roles (on any node, inherited down the tree) that see the section; the platform admin sees every section */
  roles: readonly ChannelRole[];
}

/** Phase 1 sections (IA_AND_JOURNEYS §4.10) and who sees them (PRD §4.3, ARCHITECTURE_DELTA §5.3). */
export const ADMIN_SECTION_PLAN = {
  tree: { owner: 'P1-T4', order: 10, title_ar: 'الشجرة', roles: ['admin'] },
  members: { owner: 'P1-T4', order: 20, title_ar: 'الأعضاء وطلبات الانضمام', roles: ['admin', 'assistant'] },
  codes: { owner: 'P1-T4', order: 30, title_ar: 'الرموز والدعوات', roles: ['admin', 'assistant'] },
  roles: { owner: 'P1-T4', order: 40, title_ar: 'الأدوار', roles: ['admin'] },
  official: { owner: 'P1-T5', order: 50, title_ar: 'المحتوى الرسمي', roles: ['admin', 'subject_moderator', 'contributor'] },
  duplicates: { owner: 'P1-T5', order: 60, title_ar: 'الملفات المكررة', roles: ['admin', 'subject_moderator'] },
  moderation: { owner: 'P1-T4', order: 70, title_ar: 'الإشراف', roles: ['admin', 'assistant', 'subject_moderator'] },
  // Phase 1: approving contributors' attachments (exam dates join it in Phase 2) — IA §4.10; review W2-step0 R10
  files: { owner: 'P1-T5', order: 75, title_ar: 'الملفات والمواعيد', roles: ['admin', 'subject_moderator'] },
  audit: { owner: 'P1-T4', order: 80, title_ar: 'سجل الإجراءات', roles: ['admin', 'assistant'] },
} as const satisfies Record<string, AdminSectionPlan>;

export type AdminSectionId = keyof typeof ADMIN_SECTION_PLAN;

/** What a track registers: its section's id, a one-line Arabic description and its lazily loaded screen. */
export interface AdminSectionRegistration {
  id: AdminSectionId;
  /** the track registering it — must be the plan's owner */
  owner: AdminSectionOwner;
  description_ar: string;
  lazy: () => Promise<{ Component: ComponentType }>;
}

export interface AdminSection extends AdminSectionRegistration {
  title_ar: string;
  order: number;
  roles: readonly ChannelRole[];
  path: `/admin/${AdminSectionId}`;
}

const registry = new Map<AdminSectionId, AdminSection>();

/** Registers a BUILT section (call it from the track's own feature folder). Throws on any misuse. */
export function registerAdminSection(reg: AdminSectionRegistration): AdminSection {
  const plan: AdminSectionPlan | undefined = (ADMIN_SECTION_PLAN as Record<string, AdminSectionPlan>)[reg.id];
  if (!plan) throw new Error(`admin section not planned: ${String(reg.id)}`);
  if (plan.owner !== reg.owner) throw new Error(`admin section ${reg.id} is owned by ${plan.owner}, not ${reg.owner}`);
  if (registry.has(reg.id)) throw new Error(`admin section already registered: ${reg.id}`);
  if (!/[\u0600-\u06ff]/.test(reg.description_ar)) throw new Error(`admin section ${reg.id}: the description must be Arabic`);
  const section: AdminSection = { ...reg, title_ar: plan.title_ar, order: plan.order, roles: plan.roles, path: `/admin/${reg.id}` };
  registry.set(reg.id, section);
  return section;
}

/** Every registered section, in the plan's order. */
export function adminSections(): readonly AdminSection[] {
  return [...registry.values()].sort((a, b) => a.order - b.order);
}

/** The sections a viewer's roles open (the menu of «إدارة القنوات»); none for a viewer without a role. */
export function visibleAdminSections(viewer: { roles: readonly ChannelRole[]; isPlatformAdmin: boolean }): AdminSection[] {
  return adminSections().filter((s) => viewer.isPlatformAdmin || s.roles.some((r) => viewer.roles.includes(r)));
}
