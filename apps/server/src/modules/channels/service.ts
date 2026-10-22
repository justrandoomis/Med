// The channels service (P1-T4 step 1; ARCHITECTURE_DELTA §4.1 `2050_directory` / `2100_permissions`, §5, §7.3; PRD
// AOS-2.1, 2.11–2.15, 18.1, 18.2, 18.5, 18.6, 21.2–21.6, 21.18). The university tree with its closure, one space per
// subject (created through P1-T1's registry), memberships, class codes and invite links with the public preview, join
// approvals, invitations, roles with inheritance — every action asked of the ONE policy (`ctx.authz`) first, every
// change recorded in the scoped security audit (no private content: titles, ids and counts only).
//
// One instance per application context (`channelsOf(ctx)`): the plugin (routes), the authz rules, gate 2 and P1-T1's
// JoinTokenVerifier (registration) all share it. This file is the only one of the module that holds the system DB
// handle and calls the registry's internal methods (test/tenancy/import-boundary.test.ts lists it).
import { rmSync } from 'node:fs';
import {
  type AssignRoleRequest,
  type ChannelArchiveResponse,
  type ChannelMembershipView,
  type ChannelNodeDetail,
  type ChannelNodeView,
  type ChannelRolesResponse,
  type ChannelRoleView,
  type ChannelTreeQuery,
  type ChannelTreeResponse,
  type CourseFollowRequest,
  type CourseFollowView,
  type CourseUnfollowResponse,
  type CreateChannelNodeRequest,
  type CreateJoinCodeRequest,
  type CreateJoinCodeResponse,
  type InvitationDecisionResponse,
  type InvitationsResponse,
  type InvitationView,
  type InviteeCandidate,
  type InviteeSearchResponse,
  isDescendingKind,
  type JoinCodesResponse,
  type JoinCodeView,
  type JoinPreviewResponse,
  type JoinResponse,
  type MemberDecisionRequest,
  type MembersResponse,
  type MemberView,
  type MembershipStatus,
  type PatchChannelNodeRequest,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { deriveKey, loadOrCreateServerSecret } from '../../lib/secret';
import type { Viewer } from '../../system/binding';
import { normalizeUsername } from '../../system/repos';
import type { Action, Resource } from '../authz/policy';
import { CHANNEL_ROOT_ID, registerChannelRules } from '../authz/rules/channels';
import { ChannelAccess, type EffectiveAccess } from './access';
import { generateClassCode, generateLinkToken, hashJoinSecret, hintOf, isWellFormedClassCode, type JoinSecretKind } from './codes';
import { notificationsOf } from '../notifications/service';
import { JoinLimiter } from './limiter';
import { ChannelRepo, type InvitationRow, type JoinCodeRow, type MembershipRow, type NodeRow, type PersonRow } from './repo';
import { codeView, courseFollowView, invitationView, memberView, membershipView, nodeRef, roleView } from './views';

/** The body of a hidden or missing id (the policy's own 404 message): existence never leaks. */
export const NOT_FOUND_AR = 'العنصر غير موجود.';
/** The body Fastify answers for a route that does not exist: the public preview answers exactly this when invalid. */
export const MISSING_ROUTE_AR = 'المسار المطلوب غير موجود.';

const notFound = () => new AppError('NOT_FOUND', NOT_FOUND_AR, 404);
const missingRoute = () => new AppError('NOT_FOUND', MISSING_ROUTE_AR, 404);
const invalidCode = () => new AppError('JOIN_CODE_INVALID', 'رمز الانضمام أو رابط الدعوة غير صالح أو منتهٍ أو استُنفد. تأكد منه أو اطلب رمزًا جديدًا من مشرف القناة.', 400);
const archivedError = () => new AppError('CONFLICT', 'هذه القناة مؤرشفة: لا تقبل تعديلًا أو أعضاء جددًا.', 409);
const validation = (path: string, message: string) => new AppError('VALIDATION_FAILED', message, 400, { where: 'body', issues: [{ path, code: 'custom', message }] });

const DATED_KINDS = new Set(['academic_year', 'course']);
const INVITATION_TTL_MS = 14 * 24 * 60 * 60_000;
const TREE_LIMIT = 500;
const HOUR = 60 * 60_000;

/** What P1-T1's JoinTokenVerifier hands back between «verify» (one use reserved) and «redeem» / «release». */
export interface ChannelJoinTicket {
  describeAr: string;
  codeId: string;
  nodeId: string;
  kind: JoinSecretKind;
}

export class ChannelService {
  readonly repo: ChannelRepo;
  readonly access: ChannelAccess;
  readonly limiter: JoinLimiter;
  private readonly key: Buffer;
  private attempts = 0;

  constructor(private readonly ctx: AppContext) {
    this.repo = new ChannelRepo(ctx.system.db, ctx.clock);
    this.access = new ChannelAccess(this.repo);
    this.limiter = new JoinLimiter(ctx.system.db, ctx.clock, ctx.config.auth.loginIpFailuresPerHour);
    this.key = deriveKey(loadOrCreateServerSecret(ctx.config.dataDir), 'join-code');
  }

  /** Register the rules and gate 2's membership provider on this context's policy (the plugin calls it once). */
  install(): void {
    registerChannelRules(this.ctx.authz, this.access);
    this.ctx.authz.setMembershipProvider(this.access);
  }

  private now(): number {
    return this.ctx.clock.now();
  }

  private assert(viewer: Viewer, action: Action, r: Resource): void {
    this.ctx.authz.assert(viewer, action, r);
  }

  private can(viewer: Viewer, action: Action, r: Resource): boolean {
    return this.ctx.authz.can(viewer, action, r).allowed;
  }

  private existing(id: string): NodeRow {
    const n = this.repo.node(id);
    if (!n) throw notFound();
    return n;
  }

  /** e.g. «platform_admin», «admin@<node>», «self» — the security audit's actor role. */
  private actorRole(viewer: Viewer, nodeId: string | null): string {
    if (viewer.isPlatformAdmin) return 'platform_admin';
    if (nodeId) {
      const e = this.access.effective(viewer, nodeId);
      const r = e?.roles[0];
      if (r) return `${r.role}@${r.nodeId}`;
    }
    return 'self';
  }

  private audit(viewer: Viewer | null, e: { action: string; nodeId: string | null; targetType: string; targetId: string; summary: string; details?: Record<string, unknown>; ip?: string | null; actorUserId?: string }): void {
    this.ctx.system.securityAudit.record({
      actorUserId: e.actorUserId ?? viewer?.userId ?? null,
      actorRole: viewer ? this.actorRole(viewer, e.nodeId) : 'self',
      scopeNodeId: e.nodeId,
      action: e.action,
      targetDb: 'system',
      targetType: e.targetType,
      targetId: e.targetId,
      summary: e.summary,
      details: e.details ?? null,
      ip: e.ip ?? null,
    });
  }

  // ───────────────────────── views ─────────────────────────

  private nodeViewOf(node: NodeRow, e: EffectiveAccess): ChannelNodeView {
    const roles = [...new Set(e.roles.map((r) => r.role))];
    // the membership that decides here: an approval, unless a nearer removal overrides it (review R2)
    const decisive = ChannelAccess.decisive(e);
    const approved = decisive?.status === 'approved' ? decisive : null;
    const own = e.memberships.find((m) => m.depth === 0) ?? null;
    const pending = e.memberships.find((m) => m.status === 'pending') ?? null;
    const shown = approved ?? own ?? decisive ?? pending;
    const chainNode = (id: string) => e.chain.find((a) => a.id === id)!;
    const holdsHere = e.roles.some((r) => r.depth === 0) || own?.status === 'approved';
    let inherited: ChannelNodeView['viewer']['inherited_from'] = null;
    if (!holdsHere) {
      const sources = [...e.roles.map((r) => r.depth), ...(approved ? [approved.depth] : [])].filter((d) => d > 0);
      if (sources.length > 0) {
        const nearest = e.chain.find((a) => a.depth === Math.min(...sources))!;
        inherited = nodeRef(nearest);
      }
    }
    const s = ChannelAccess.subjectAccess(e);
    return {
      id: node.id,
      kind: node.kind,
      title: node.title,
      parent_id: node.parent_id,
      title_en: node.title_en,
      ordinal: node.ordinal,
      starts_on: node.starts_on,
      ends_on: node.ends_on,
      has_space: node.space_id !== null,
      space_id: node.space_id && s && !s.pending ? node.space_id : null,
      join_policy: node.join_policy,
      status: e.archived ? 'archived' : node.status,
      viewer: {
        membership: shown ? membershipView(shown, chainNode(shown.node_id)) : null,
        roles,
        inherited_from: inherited,
        course_follow: null,
      },
    };
  }

  private nodeView(viewer: Viewer, node: NodeRow): ChannelNodeView {
    const e = this.access.effective(viewer, node.id);
    if (!e) throw notFound();
    const view = this.nodeViewOf(node, e);
    if (node.kind === 'subject') {
      const f = this.repo.courseFollow(viewer.userId, node.id);
      view.viewer.course_follow = f ? courseFollowView(f, node) : null;
    }
    return view;
  }

  nodeDetail(viewer: Viewer, id: string): ChannelNodeDetail {
    this.assert(viewer, 'view', { type: 'channel_node', id });
    const node = this.existing(id);
    const path = this.repo
      .ancestors(id)
      .filter((a) => a.depth > 0)
      .sort((a, b) => b.depth - a.depth)
      .map(nodeRef);
    return { ...this.nodeView(viewer, node), path };
  }

  tree(viewer: Viewer, q: ChannelTreeQuery): ChannelTreeResponse {
    let nodes: NodeRow[];
    let truncated = false;
    if (q.root) {
      this.assert(viewer, 'list', { type: 'channel_node', id: q.root });
      const root = this.existing(q.root);
      const below = this.repo.descendants(root.id, q.depth, TREE_LIMIT + 1);
      truncated = below.length > TREE_LIMIT;
      nodes = [root, ...below.slice(0, TREE_LIMIT)];
    } else {
      this.assert(viewer, 'list', { type: 'channel_node', id: CHANNEL_ROOT_ID });
      const roots = this.repo.roots();
      nodes = [];
      for (const r of roots) {
        if (nodes.length >= TREE_LIMIT) {
          truncated = true;
          break;
        }
        nodes.push(r);
        if (q.depth > 1) {
          const below = this.repo.descendants(r.id, q.depth - 1, TREE_LIMIT + 1 - nodes.length);
          if (nodes.length + below.length > TREE_LIMIT) truncated = true;
          nodes.push(...below.slice(0, TREE_LIMIT - nodes.length));
        }
      }
    }
    const eff = this.access.effectiveMany(viewer, nodes);
    const views = nodes.filter((n) => eff.has(n.id)).map((n) => this.nodeViewOf(n, eff.get(n.id)!));
    for (const v of views) {
      if (v.kind !== 'subject') continue;
      const f = this.repo.courseFollow(viewer.userId, v.id);
      v.viewer.course_follow = f ? courseFollowView(f, v) : null;
    }
    return { nodes: views, truncated };
  }

  // ───────────────────────── tree changes ─────────────────────────

  createNode(viewer: Viewer, body: CreateChannelNodeRequest, ip: string | null): ChannelNodeView {
    let parent: NodeRow | null = null;
    if (body.parent_id === null) {
      this.assert(viewer, 'create', { type: 'channel_node', id: CHANNEL_ROOT_ID });
      if (body.kind !== 'university') throw validation('kind', 'العقدة العليا في الشجرة جامعة دائمًا؛ أضف الكلية أو المادة تحت جامعة.');
    } else {
      this.assert(viewer, 'create', { type: 'channel_node', id: body.parent_id });
      parent = this.existing(body.parent_id);
      if (this.access.effective(viewer, parent.id)!.archived) throw archivedError();
      if (!isDescendingKind(parent.kind, body.kind)) throw validation('kind', 'لا يمكن إضافة هذا النوع هنا: المستويات تنزل من الجامعة إلى المادة، والمادة آخر مستوى.');
    }
    if ((body.starts_on || body.ends_on) && !DATED_KINDS.has(body.kind)) throw validation('starts_on', 'التواريخ للسنة الدراسية والفصل أو المقرر فقط.');
    if (body.kind === 'subject' && body.create_space === false) throw validation('create_space', 'لكل مادة مساحتها المشتركة الخاصة؛ لا تُنشأ مادة بلا مساحة.');
    if (body.kind !== 'subject' && body.create_space === true) throw validation('create_space', 'المساحة المشتركة للمواد فقط في هذه المرحلة.');

    const id = newId(this.now());
    let spaceId: string | null = null;
    let dbFile: string | null = null;
    if (body.kind === 'subject') {
      spaceId = newId(this.now());
      // the file first (from the migrated template, atomically), then every row in ONE system transaction
      dbFile = this.ctx.pool.createFile('space', spaceId);
    }
    try {
      this.ctx.system.db.tx(() => {
        if (spaceId && dbFile) this.ctx.system.vaults.registerSpaceInternal({ id: spaceId, title: body.title, dbFile });
        this.repo.insertNode({
          id,
          parent_id: body.parent_id,
          kind: body.kind,
          title: body.title,
          title_en: body.title_en ?? null,
          ordinal: body.ordinal ?? null,
          starts_on: body.starts_on ?? null,
          ends_on: body.ends_on ?? null,
          space_id: spaceId,
          join_policy: body.join_policy ?? 'approval',
          created_by: viewer.userId,
        });
        this.audit(viewer, { action: 'channel_node_create', nodeId: id, targetType: 'channel_node', targetId: id, summary: `إنشاء ${body.kind === 'subject' ? 'مادة' : 'عقدة'}: ${body.title}`, details: { kind: body.kind, parent_id: body.parent_id, space_id: spaceId }, ip });
      });
    } catch (e) {
      if (dbFile) for (const suffix of ['', '-wal', '-shm']) rmSync(`${this.ctx.pool.pathOfFile('space', dbFile)}${suffix}`, { force: true });
      throw e;
    }
    return this.nodeView(viewer, this.repo.node(id)!);
  }

  patchNode(viewer: Viewer, id: string, body: PatchChannelNodeRequest, ip: string | null): ChannelNodeView {
    this.assert(viewer, 'edit', { type: 'channel_node', id });
    const node = this.existing(id);
    if (this.access.effective(viewer, id)!.archived) throw archivedError();
    let moveTo: NodeRow | null = null;
    if (body.parent_id !== undefined && body.parent_id !== node.parent_id) {
      if (node.parent_id === null) throw validation('parent_id', 'الجامعة عقدة عليا ولا تُنقل تحت عقدة أخرى.');
      // a move takes the node away from the Admins above it: only someone who administers its CURRENT place (Admin of
      // the parent or above, or the platform admin) may move it, and only to a place they administer too (review
      // P1-T4 step 1, R6 — an Admin of one subject cannot carry it off into another university they run)
      if (!this.can(viewer, 'create', { type: 'channel_node', id: node.parent_id })) {
        throw new AppError('FORBIDDEN', 'نقل العقدة من صلاحية من يدير مكانها الحالي: يلزم أن تكون مديرًا لما فوقها وللوجهة معًا.', 403);
      }
      this.assert(viewer, 'create', { type: 'channel_node', id: body.parent_id });
      moveTo = this.existing(body.parent_id);
      if (this.repo.isInside(moveTo.id, node.id)) throw validation('parent_id', 'لا يمكن نقل العقدة تحت نفسها أو تحت إحدى العقد التابعة لها.');
      if (!isDescendingKind(moveTo.kind, node.kind)) throw validation('parent_id', 'لا يمكن نقل العقدة تحت هذا النوع: المستويات تنزل من الجامعة إلى المادة.');
      if (this.access.effective(viewer, moveTo.id)!.archived) throw archivedError();
    }
    const startsOn = body.starts_on !== undefined ? body.starts_on : node.starts_on;
    const endsOn = body.ends_on !== undefined ? body.ends_on : node.ends_on;
    if ((body.starts_on || body.ends_on) && !DATED_KINDS.has(node.kind)) throw validation('starts_on', 'التواريخ للسنة الدراسية والفصل أو المقرر فقط.');
    if (startsOn && endsOn && startsOn > endsOn) throw validation('ends_on', 'تاريخ النهاية قبل تاريخ البداية.');
    const patch: Parameters<ChannelRepo['updateNode']>[1] = {};
    if (body.title !== undefined) patch.title = body.title;
    if (body.title_en !== undefined) patch.title_en = body.title_en;
    if (body.ordinal !== undefined) patch.ordinal = body.ordinal;
    if (body.starts_on !== undefined) patch.starts_on = body.starts_on;
    if (body.ends_on !== undefined) patch.ends_on = body.ends_on;
    if (body.join_policy !== undefined) patch.join_policy = body.join_policy;
    this.ctx.system.db.tx(() => {
      this.repo.updateNode(id, patch);
      if (moveTo) this.repo.moveNode(id, moveTo.id);
      if (body.title !== undefined && node.space_id) this.repo.setSpaceTitle(node.space_id, body.title);
      this.audit(viewer, { action: moveTo ? 'channel_node_move' : 'channel_node_edit', nodeId: id, targetType: 'channel_node', targetId: id, summary: `تعديل العقدة: ${body.title ?? node.title}`, details: { fields: Object.keys(body) }, ip });
    });
    return this.nodeView(viewer, this.repo.node(id)!);
  }

  archive(viewer: Viewer, id: string, preview: boolean, ip: string | null): ChannelArchiveResponse {
    this.assert(viewer, 'delete', { type: 'channel_node', id });
    const node = this.existing(id);
    const subtree = this.repo.subtreeIds(id);
    const nodes = this.repo.nodesByIds(subtree);
    const spaces = nodes.map((n) => n.space_id).filter((s): s is string => s !== null);
    const openCodes = this.repo.openCodeIds(subtree);
    const impact: ChannelArchiveResponse['preview'] = {
      node: nodeRef(node),
      descendants: subtree.length - 1,
      memberships: this.repo.liveMembershipCount(subtree),
      spaces: spaces.length,
      open_codes: openCodes.length,
    };
    if (preview) return { preview: impact, archived: false };
    if (node.status === 'archived') return { preview: impact, archived: true };
    this.ctx.system.db.tx(() => {
      this.repo.archiveSubtree(id);
      for (const c of openCodes) this.repo.revokeCode(c);
      // pending invitations into the subtree could only fail now (409): they are taken back too (review R7)
      this.repo.revokePendingInvitations(subtree);
      this.repo.setSpacesReadOnly(spaces);
      this.audit(viewer, { action: 'channel_node_archive', nodeId: id, targetType: 'channel_node', targetId: id, summary: `أرشفة: ${node.title}`, details: { ...impact, node: undefined }, ip });
    });
    return { preview: impact, archived: true };
  }

  // ───────────────────────── members ─────────────────────────

  members(viewer: Viewer, nodeId: string, q: { status?: MembershipStatus; cursor?: string; limit: number }): MembersResponse {
    this.assert(viewer, 'manage_members', { type: 'channel_node', id: nodeId });
    this.existing(nodeId);
    let after: { created_at: number; id: string } | null = null;
    if (q.cursor) {
      try {
        const [createdAt, id] = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')) as [number, string];
        if (typeof createdAt !== 'number' || typeof id !== 'string') throw new Error('cursor');
        after = { created_at: createdAt, id };
      } catch {
        throw validation('cursor', 'مؤشر الصفحة غير صالح.');
      }
    }
    const rows = this.repo.membersPage(nodeId, q.status, after, q.limit + 1);
    const page = rows.slice(0, q.limit);
    const people = this.repo.people(page.flatMap((m) => [m.user_id, ...(m.decided_by ? [m.decided_by] : [])]));
    const roles = this.repo.rolesOnNodes([nodeId]);
    const last = page[page.length - 1];
    return {
      items: page.map((m) => memberView(m, people, roles)),
      next_cursor: rows.length > q.limit && last ? Buffer.from(JSON.stringify([last.created_at, last.id])).toString('base64url') : null,
    };
  }

  decideMember(viewer: Viewer, nodeId: string, userId: string, body: MemberDecisionRequest, ip: string | null): MemberView {
    this.assert(viewer, 'manage_members', { type: 'channel_node', id: nodeId });
    const node = this.existing(nodeId);
    if (userId === viewer.userId) throw new AppError('FORBIDDEN', 'لا يمكنك البتّ في عضويتك بنفسك؛ يقرر فيها مشرف آخر.', 403);
    const m = this.repo.membership(nodeId, userId);
    if (!m) throw notFound();
    if (this.access.effective(viewer, nodeId)!.archived) throw archivedError();
    const target: Record<MemberDecisionRequest['decision'], { to: MembershipStatus; from: MembershipStatus[] }> = {
      approve: { to: 'approved', from: ['pending', 'rejected'] },
      reject: { to: 'rejected', from: ['pending'] },
      remove: { to: 'removed', from: ['approved', 'pending'] },
    };
    const t = target[body.decision];
    if (m.status !== t.to) {
      if (!t.from.includes(m.status)) throw new AppError('CONFLICT', 'لا ينطبق هذا القرار على حالة العضوية الحالية.', 409, { status: m.status });
      this.ctx.system.db.tx(() => {
        this.repo.decideMembership(m.id, t.to, viewer.userId, body.reason ?? null);
        this.audit(viewer, { action: 'channel_membership_decide', nodeId, targetType: 'channel_membership', targetId: m.id, summary: `قرار عضوية (${body.decision}) في: ${node.title}`, details: { decision: body.decision, user_id: userId }, ip });
        // the requester is told in the inbox (P1-T4 step 2): the decision, the node's title and who decided — no reason
        // text in the notice (it stays on the membership, where the member reads it)
        this.notifyDecision(node, this.repo.membershipById(m.id)!, viewer);
      });
    }
    const fresh = this.repo.membershipById(m.id)!;
    const people = this.repo.people([fresh.user_id, ...(fresh.decided_by ? [fresh.decided_by] : [])]);
    return memberView(fresh, people, this.repo.rolesOnNodes([nodeId]));
  }

  // ───────────────────────── codes and links ─────────────────────────

  createCode(viewer: Viewer, nodeId: string, body: CreateJoinCodeRequest, ip: string | null): CreateJoinCodeResponse {
    this.assert(viewer, 'manage_codes', { type: 'channel_node', id: nodeId });
    const node = this.existing(nodeId);
    if (this.access.effective(viewer, nodeId)!.archived) throw archivedError();
    if (node.join_policy === 'closed') throw new AppError('CONFLICT', 'هذه القناة بدعوة فقط: لا تُنشأ لها رموز أو روابط انضمام. غيّر سياسة الانضمام أو أرسل دعوات.', 409);
    if (node.join_policy === 'approval' && !body.requires_approval) {
      throw new AppError('CONFLICT', 'سياسة هذه القناة: كل طلب انضمام يحتاج موافقة. غيّرها إلى «برمز الانضمام مباشرة» أولًا إن أردت رمزًا يقبل دون موافقة.', 409);
    }
    const now = this.now();
    let secret = '';
    let row: JoinCodeRow | null = null;
    for (let attempt = 0; attempt < 5 && !row; attempt++) {
      secret = body.kind === 'class_code' ? generateClassCode() : generateLinkToken();
      const hash = hashJoinSecret(this.key, body.kind, secret);
      if (this.repo.codeByHash(hash)) continue;
      const id = newId(now);
      row = this.ctx.system.db.tx(() => {
        const r = this.repo.insertCode({
          id,
          node_id: nodeId,
          kind: body.kind,
          secret_hash: hash,
          hint: hintOf(body.kind, secret),
          requires_approval: body.requires_approval ? 1 : 0,
          max_uses: body.max_uses ?? null,
          expires_at: now + body.expires_in_hours * HOUR,
          created_by: viewer.userId,
        });
        this.audit(viewer, { action: 'channel_code_create', nodeId, targetType: 'join_code', targetId: id, summary: `${body.kind === 'class_code' ? 'رمز انضمام' : 'رابط دعوة'} جديد لـ: ${node.title}`, details: { kind: body.kind, expires_in_hours: body.expires_in_hours, max_uses: body.max_uses ?? null, requires_approval: body.requires_approval }, ip });
        return r;
      });
    }
    if (!row) throw new AppError('INTERNAL', 'تعذر إنشاء رمز فريد. أعد المحاولة.', 500);
    const view = codeView(row, node, this.repo.people([row.created_by]));
    if (body.kind === 'class_code') return { view, code: secret };
    const link = `${this.ctx.config.origin}/join/${secret}`;
    return { view, link, qr_payload: link };
  }

  listCodes(viewer: Viewer, nodeId: string): JoinCodesResponse {
    this.assert(viewer, 'manage_codes', { type: 'channel_node', id: nodeId });
    const node = this.existing(nodeId);
    const rows = this.repo.codesOfNode(nodeId);
    const people = this.repo.people(rows.map((r) => r.created_by));
    return { codes: rows.map((r) => codeView(r, node, people)) };
  }

  /** Id-addressed: anyone who may not manage the code's node gets the 404 of a missing id. */
  revokeCode(viewer: Viewer, codeId: string, ip: string | null): JoinCodeView {
    const row = this.repo.code(codeId);
    if (!row || !this.can(viewer, 'manage_codes', { type: 'channel_node', id: row.node_id })) throw notFound();
    const node = this.existing(row.node_id);
    if (row.revoked_at === null) {
      this.ctx.system.db.tx(() => {
        this.repo.revokeCode(codeId);
        this.audit(viewer, { action: 'channel_code_revoke', nodeId: row.node_id, targetType: 'join_code', targetId: codeId, summary: `إلغاء ${row.kind === 'class_code' ? 'رمز انضمام' : 'رابط دعوة'} لـ: ${node.title}`, ip });
      });
    }
    const fresh = this.repo.code(codeId)!;
    return codeView(fresh, node, this.repo.people([fresh.created_by]));
  }

  /** A usable code / link for this secret, or null (wrong, expired, revoked, exhausted, closed or archived). */
  private usableCode(kind: JoinSecretKind, secret: string): { code: JoinCodeRow; node: NodeRow } | null {
    if (kind === 'class_code' && !isWellFormedClassCode(secret)) return null;
    if (kind === 'invite_link' && !/^[A-Za-z0-9_-]{16,128}$/.test(secret)) return null;
    const code = this.repo.codeByHash(hashJoinSecret(this.key, kind, secret));
    if (!code || code.kind !== kind || code.revoked_at !== null || code.expires_at <= this.now()) return null;
    if (code.max_uses !== null && code.use_count >= code.max_uses) return null;
    const chain = this.repo.ancestors(code.node_id);
    const node = chain[0];
    if (!node || chain.some((a) => a.status === 'archived') || node.join_policy === 'closed') return null;
    return { code, node };
  }

  private needsApproval(code: JoinCodeRow, node: NodeRow): boolean {
    return code.requires_approval === 1 || node.join_policy === 'approval';
  }

  /**
   * Check the join limits, verify the proof, and record a failure when it is wrong — one synchronous step (no await),
   * so a parallel burst cannot pass the count. Only failures are written: a public route writes nothing per request.
   */
  private verified<T>(kind: 'code' | 'link' | 'preview' | 'register', userId: string | null, ip: string | null, verify: () => T | null, onWrong: () => AppError): T {
    if (++this.attempts % 200 === 0) this.limiter.prune();
    const addr = ip ?? 'unknown';
    this.limiter.check(kind, userId, addr);
    const found = verify();
    if (found === null) {
      this.limiter.fail(kind, userId, addr);
      throw onWrong();
    }
    return found;
  }

  private join(viewer: Viewer, kind: JoinSecretKind, secret: string, ip: string | null): JoinResponse {
    const { code, node } = this.verified(kind === 'class_code' ? 'code' : 'link', viewer.userId, ip, () => this.usableCode(kind, secret), invalidCode);
    return this.ctx.system.db.tx(() => {
      const e = this.access.effective(viewer, node.id)!;
      const approved = ChannelAccess.nearest(e, 'approved');
      if (approved) {
        const at = e.chain.find((a) => a.id === approved.node_id)!;
        return { membership: membershipView(approved, at), message_ar: 'أنت عضو في هذه القناة بالفعل.' };
      }
      const own = this.repo.membership(node.id, viewer.userId);
      if (own?.status === 'pending') return { membership: membershipView(own, node), message_ar: 'طلبك بانتظار موافقة مشرف القناة.' };
      // a person an approver turned away — removed here or above (the decisive membership is a removal), or whose
      // request here was rejected — waits for an approver again, whatever the code says: an auto-approving code never
      // overrides that decision (review P1-T4 step 1, R2/R3)
      const turnedAway = ChannelAccess.decisive(e)?.status === 'removed' || own?.status === 'removed' || own?.status === 'rejected';
      const pending = this.needsApproval(code, node) || turnedAway;
      if (!this.repo.takeUse(code.id)) throw invalidCode();
      const m = this.repo.upsertMembership({ nodeId: node.id, userId: viewer.userId, status: pending ? 'pending' : 'approved', method: kind === 'class_code' ? 'class_code' : 'invite_link', joinCodeId: code.id, decidedBy: null });
      this.audit(viewer, { action: 'channel_join', nodeId: node.id, targetType: 'channel_membership', targetId: m.id, summary: `${pending ? 'طلب انضمام' : 'انضمام'} إلى: ${node.title}`, details: { method: m.join_method, status: m.status, join_code_id: code.id }, ip });
      // the approvers are told in their inbox (P1-T4 step 2)
      if (pending) this.notifyJoinRequest(node, m);
      return { membership: membershipView(m, node), message_ar: pending ? 'طلبك بانتظار موافقة مشرف القناة.' : `انضممت إلى «${node.title}».` };
    });
  }

  joinWithCode(viewer: Viewer, code: string, ip: string | null): JoinResponse {
    return this.join(viewer, 'class_code', code, ip);
  }

  joinWithLink(viewer: Viewer, token: string, ip: string | null): JoinResponse {
    return this.join(viewer, 'invite_link', token, ip);
  }

  /** PUBLIC (ADR-0003 §3.10): the title only for a valid invite token; the body of a missing route otherwise. */
  preview(token: unknown, ip: string | null): JoinPreviewResponse {
    const found = this.verified('preview', null, ip, () => (typeof token === 'string' ? this.usableCode('invite_link', token) : null), missingRoute);
    return { title_ar: found.node.title, kind: found.node.kind, requires_approval: this.needsApproval(found.code, found.node) };
  }

  // ───────────────────────── registration (P1-T1's JoinTokenVerifier) ─────────────────────────

  /** Check a registration's proof and reserve one use of it (before the account exists). */
  reserveForRegistration(proof: { code: string } | { invite_token: string } | { invitation_id: string }, ip: string | null): ChannelJoinTicket {
    const kind: JoinSecretKind | null = 'code' in proof ? 'class_code' : 'invite_token' in proof ? 'invite_link' : null;
    const secret = 'code' in proof ? proof.code : 'invite_token' in proof ? proof.invite_token : '';
    // the use is reserved inside the same synchronous step: the account is created only after it is held. A wrong
    // invite token counts against the address budget of link registrations, anything else against that of class-code
    // registrations (a flood of wrong codes from the hall never stops the QR — review P1-T4 step 1, R1)
    const found = this.verified(kind === 'invite_link' ? 'link' : 'register', null, ip, () => {
      const f = kind ? this.usableCode(kind, secret) : null;
      return f && this.repo.takeUse(f.code.id) ? f : null;
    }, invalidCode);
    return { describeAr: found.node.title, codeId: found.code.id, nodeId: found.node.id, kind: kind! };
  }

  /** The new account joins what its proof named (pending or approved per the policy at this moment). */
  redeemRegistration(ticket: ChannelJoinTicket, userId: string, ip: string | null): ChannelMembershipView | null {
    const code = this.repo.code(ticket.codeId);
    const node = this.repo.node(ticket.nodeId);
    if (!code || !node) return null;
    return this.ctx.system.db.tx(() => {
      const pending = this.needsApproval(code, node);
      const m = this.repo.upsertMembership({ nodeId: node.id, userId, status: pending ? 'pending' : 'approved', method: ticket.kind === 'class_code' ? 'class_code' : 'invite_link', joinCodeId: code.id, decidedBy: null });
      this.audit(null, { action: 'channel_join', actorUserId: userId, nodeId: node.id, targetType: 'channel_membership', targetId: m.id, summary: `تسجيل حساب جديد و${pending ? 'طلب انضمام' : 'انضمام'} إلى: ${node.title}`, details: { method: m.join_method, status: m.status, join_code_id: code.id }, ip });
      if (pending) this.notifyJoinRequest(node, m);
      return membershipView(m, node);
    });
  }

  /** The account creation failed after the use was reserved: give it back. */
  releaseRegistration(ticket: ChannelJoinTicket): void {
    this.repo.giveUseBack(ticket.codeId);
  }

  // ───────────────────────── invitations ─────────────────────────

  invite(viewer: Viewer, nodeId: string, userIds: string[], ip: string | null): InvitationsResponse {
    this.assert(viewer, 'manage_members', { type: 'channel_node', id: nodeId });
    const node = this.existing(nodeId);
    if (this.access.effective(viewer, nodeId)!.archived) throw archivedError();
    // nobody invites themselves: the membership would outlive the role that sent it (review P1-T4 step 1, R5)
    if (userIds.includes(viewer.userId)) throw new AppError('FORBIDDEN', 'لا يمكنك دعوة نفسك؛ يدعوك مشرف آخر في القناة.', 403);
    for (const id of userIds) if (!this.repo.activePerson(id)) throw notFound();
    const sent = this.ctx.system.db.tx(() => {
      const out = [];
      for (const userId of userIds) {
        const e = this.access.effective({ userId, deviceId: null, isPlatformAdmin: false }, nodeId)!;
        if (ChannelAccess.nearest(e, 'approved')) continue; // already in
        let inv = this.repo.pendingInvitation(nodeId, userId);
        if (inv && inv.expires_at <= this.now()) {
          this.repo.decideInvitation(inv.id, 'expired');
          inv = null;
        }
        out.push(inv ?? this.repo.insertInvitation(nodeId, userId, viewer.userId, this.now() + INVITATION_TTL_MS));
      }
      this.audit(viewer, { action: 'channel_invite', nodeId, targetType: 'channel_node', targetId: nodeId, summary: `دعوة ${out.length} إلى: ${node.title}`, details: { count: out.length }, ip });
      // each invitee is told once per invitation (inviting again returns the same pending invitation: same key)
      for (const inv of out) {
        notificationsOf(this.ctx).publish({
          content: { kind: 'invitation', payload: { node_title: node.title } },
          actorUserId: viewer.userId,
          target: { db: 'system', type: 'channel_node', id: nodeId },
          dedupeKey: `invitation:${inv.id}`,
          audience: { kind: 'users', user_ids: [inv.invitee_user_id] },
        });
      }
      return out;
    });
    const people = this.repo.people(sent.flatMap((i) => [i.invitee_user_id, i.invited_by]));
    return { invitations: sent.map((i) => invitationView(i, node, people)) };
  }

  /**
   * An invitation lets its invitee in only while its sender may still manage the node's members (review P1-T4 step 1,
   * R4): revoking an Assistant's or Admin's role (or deleting the account) takes back the invitations they sent.
   */
  private inviterMayStill(inv: InvitationRow): boolean {
    const user = this.ctx.system.users.byIdInternal(inv.invited_by);
    if (!user || user.status !== 'active') return false;
    return this.can(this.ctx.tenancy.viewerOf(user, null), 'manage_members', { type: 'channel_node', id: inv.node_id });
  }

  myInvitations(viewer: Viewer): InvitationsResponse {
    const rows = this.repo.pendingInvitationsOf(viewer.userId).filter((r) => {
      if (this.inviterMayStill(r)) return true;
      this.repo.decideInvitation(r.id, 'revoked');
      return false;
    });
    const nodes = new Map(this.repo.nodesByIds(rows.map((r) => r.node_id)).map((n) => [n.id, n]));
    const people = this.repo.people(rows.flatMap((i) => [i.invitee_user_id, i.invited_by]));
    return { invitations: rows.filter((r) => nodes.has(r.node_id)).map((r) => invitationView(r, nodes.get(r.node_id)!, people)) };
  }

  decideInvitation(viewer: Viewer, id: string, accept: boolean, ip: string | null): InvitationDecisionResponse {
    const inv = this.repo.invitation(id);
    if (!inv || inv.invitee_user_id !== viewer.userId) throw notFound();
    const node = this.existing(inv.node_id);
    if (inv.status === 'pending' && inv.expires_at <= this.now()) this.repo.decideInvitation(inv.id, 'expired');
    else if (inv.status === 'pending' && !this.inviterMayStill(inv)) this.repo.decideInvitation(inv.id, 'revoked');
    const current = this.repo.invitation(id)!;
    if (current.status !== 'pending') throw new AppError('CONFLICT', current.status === 'expired' ? 'انتهت صلاحية هذه الدعوة؛ اطلب دعوة جديدة.' : 'هذه الدعوة لم تعد قائمة.', 409);
    if (this.access.effective(viewer, node.id)!.archived) throw archivedError();
    const membership = this.ctx.system.db.tx(() => {
      this.repo.decideInvitation(id, accept ? 'accepted' : 'declined');
      if (!accept) {
        this.audit(viewer, { action: 'channel_invitation_decline', nodeId: node.id, targetType: 'channel_invitation', targetId: id, summary: `رفض دعوة إلى: ${node.title}`, ip });
        return null;
      }
      const m = this.repo.upsertMembership({ nodeId: node.id, userId: viewer.userId, status: 'approved', method: 'invitation', joinCodeId: null, decidedBy: inv.invited_by });
      this.audit(viewer, { action: 'channel_join', nodeId: node.id, targetType: 'channel_membership', targetId: m.id, summary: `قبول دعوة إلى: ${node.title}`, details: { method: 'invitation' }, ip });
      return m;
    });
    const people = this.repo.people([inv.invitee_user_id, inv.invited_by]);
    return {
      invitation: invitationView(this.repo.invitation(id)!, node, people),
      membership: membership ? membershipView(membership, node) : null,
      message_ar: accept ? `انضممت إلى «${node.title}».` : 'رفضت الدعوة.',
    };
  }

  /** (C2, AOS-18.5) The invitations sent into a node (Admins / Assistants of it; others 403 like the members list). */
  nodeInvitations(viewer: Viewer, nodeId: string, status: InvitationView['status'] | undefined): InvitationsResponse {
    this.assert(viewer, 'manage_members', { type: 'channel_node', id: nodeId });
    const node = this.existing(nodeId);
    // a pending invitation whose sender lost the power to send it is taken back (review P1-T4 step 1, R4) — said so here
    for (const r of this.repo.invitationsOfNode(nodeId, 'pending')) if (!this.inviterMayStill(r)) this.repo.decideInvitation(r.id, 'revoked');
    const rows = this.repo.invitationsOfNode(nodeId, status);
    const people = this.repo.people(rows.flatMap((i) => [i.invitee_user_id, i.invited_by]));
    return { invitations: rows.map((r) => invitationView(r, node, people)) };
  }

  /** (C2, AOS-18.5) Revoke a pending invitation. Id-addressed: anyone who may not manage the node meets a missing id. */
  revokeInvitation(viewer: Viewer, id: string, ip: string | null): InvitationView {
    const inv = this.repo.invitation(id);
    if (!inv || !this.can(viewer, 'manage_members', { type: 'channel_node', id: inv.node_id })) throw notFound();
    const node = this.existing(inv.node_id);
    if (inv.status === 'pending' && inv.expires_at <= this.now()) this.repo.decideInvitation(inv.id, 'expired');
    const current = this.repo.invitation(id)!;
    if (current.status === 'pending') {
      this.ctx.system.db.tx(() => {
        this.repo.decideInvitation(id, 'revoked');
        this.audit(viewer, { action: 'channel_invitation_revoke', nodeId: node.id, targetType: 'channel_invitation', targetId: id, summary: `إلغاء دعوة إلى: ${node.title}`, ip });
      });
    } else if (current.status !== 'revoked') {
      throw new AppError('CONFLICT', current.status === 'expired' ? 'انتهت صلاحية هذه الدعوة من قبل؛ لا حاجة لإلغائها.' : 'قُرّرت هذه الدعوة من قبل؛ لم يتغير شيء.', 409);
    }
    const fresh = this.repo.invitation(id)!;
    return invitationView(fresh, node, this.repo.people([fresh.invitee_user_id, fresh.invited_by]));
  }

  /**
   * (C2, AOS-18.5) The person picker: the account whose username is exactly `q`, and the approved members of the
   * channels the inviter manages around this node (below the topmost ancestor they manage) whose name or username
   * starts with `q`. Never a directory of every account; at most 10.
   */
  searchInvitees(viewer: Viewer, nodeId: string, q: string): InviteeSearchResponse {
    this.assert(viewer, 'manage_members', { type: 'channel_node', id: nodeId });
    this.existing(nodeId);
    const found = new Map<string, { display_name: string; match: InviteeCandidate['match']; where: string | null }>();
    const exact = this.repo.activePersonByUsername(normalizeUsername(q));
    if (exact && exact.id !== viewer.userId) found.set(exact.id, { display_name: exact.display_name, match: 'username', where: null });
    const managed = [...this.repo.ancestors(nodeId)].reverse().find((a) => this.can(viewer, 'manage_members', { type: 'channel_node', id: a.id }));
    if (managed) {
      const rows = this.repo.searchMembers(this.repo.subtreeIds(managed.id), q.normalize('NFKC').trim(), 10);
      const titles = new Map(this.repo.nodesByIds(rows.map((r) => r.node_id)).map((n) => [n.id, n.title]));
      for (const r of rows) {
        if (r.user_id === viewer.userId || found.has(r.user_id)) continue;
        found.set(r.user_id, { display_name: r.display_name, match: 'member', where: titles.has(r.node_id) ? `عضو في «${titles.get(r.node_id)}»` : null });
      }
    }
    const candidates: InviteeCandidate[] = [...found].slice(0, 10).map(([userId, f]) => {
      const e = this.access.effective({ userId, deviceId: null, isPlatformAdmin: false }, nodeId)!;
      const state: InviteeCandidate['state'] = ChannelAccess.nearest(e, 'approved') ? 'member' : this.repo.pendingInvitation(nodeId, userId) ? 'invited' : 'can_invite';
      return { user: { id: userId, display_name: f.display_name, avatar_url: null }, match: f.match, where_ar: f.where, state };
    });
    return { candidates };
  }

  // ───────────────────────── roles ─────────────────────────

  /** Roles on the node and the ones it inherits from its ancestors (root first). */
  roles(viewer: Viewer, nodeId: string): ChannelRolesResponse {
    this.assert(viewer, 'manage_members', { type: 'channel_node', id: nodeId });
    this.existing(nodeId);
    const chain = this.repo.ancestors(nodeId);
    const byId = new Map(chain.map((a) => [a.id, a]));
    const rows = this.repo.rolesOnNodes(chain.map((a) => a.id)).sort((a, b) => byId.get(b.node_id)!.depth - byId.get(a.node_id)!.depth || a.created_at - b.created_at);
    const people = this.repo.people(rows.flatMap((r) => [r.user_id, r.granted_by]));
    return { roles: rows.map((r) => roleView(r, byId.get(r.node_id)!, people)) };
  }

  assignRole(viewer: Viewer, nodeId: string, body: AssignRoleRequest, ip: string | null): ChannelRoleView {
    this.assert(viewer, 'assign_role', { type: 'channel_node', id: nodeId });
    const node = this.existing(nodeId);
    if (body.role === 'admin' && !viewer.isPlatformAdmin) throw new AppError('FORBIDDEN', 'تعيين «مدير القناة» من صلاحية مسؤول المنصة فقط؛ يعيّن المدير الأدوار التي دونه.', 403);
    if (this.access.effective(viewer, nodeId)!.archived) throw archivedError();
    if (!this.repo.activePerson(body.user_id)) throw notFound();
    const existing = this.repo.activeRole(nodeId, body.user_id, body.role);
    const row =
      existing ??
      this.ctx.system.db.tx(() => {
        const r = this.repo.insertRole(nodeId, body.user_id, body.role, viewer.userId);
        this.audit(viewer, { action: 'channel_role_grant', nodeId, targetType: 'role_assignment', targetId: r.id, summary: `منح دور (${body.role}) في: ${node.title}`, details: { role: body.role, user_id: body.user_id }, ip });
        return r;
      });
    return roleView(row, node, this.repo.people([row.user_id, row.granted_by]));
  }

  /** Id-addressed: anyone who may not assign roles on the role's node gets the 404 of a missing id. */
  revokeRole(viewer: Viewer, roleId: string, ip: string | null): ChannelRoleView {
    const row = this.repo.role(roleId);
    if (!row || row.revoked_at !== null || !this.can(viewer, 'assign_role', { type: 'channel_node', id: row.node_id })) throw notFound();
    if (row.role === 'admin' && !viewer.isPlatformAdmin) throw new AppError('FORBIDDEN', 'سحب دور «مدير القناة» من صلاحية مسؤول المنصة فقط.', 403);
    const node = this.existing(row.node_id);
    this.ctx.system.db.tx(() => {
      this.repo.revokeRole(roleId, viewer.userId);
      this.audit(viewer, { action: 'channel_role_revoke', nodeId: row.node_id, targetType: 'role_assignment', targetId: roleId, summary: `سحب دور (${row.role}) في: ${node.title}`, details: { role: row.role, user_id: row.user_id }, ip });
    });
    return roleView(row, node, this.repo.people([row.user_id, row.granted_by]));
  }

  // ───────────────────────── course follow «تابع المادة» (step 2) ─────────────────────────

  /**
   * Follow a subject (members only — the policy's `follow`: 403 MEMBERSHIP_PENDING / MEMBERSHIP_REQUIRED with the reason,
   * 403 for a node that is no subject, 404 for a missing one). The library folder, when given, must be a folder of the
   * follower's OWN vault: the request is bound to that vault, so another user's folder id is simply unknown here.
   */
  follow(viewer: Viewer, subjectId: string, body: CourseFollowRequest): CourseFollowView {
    this.assert(viewer, 'follow', { type: 'channel_node', id: subjectId });
    const node = this.existing(subjectId);
    const folder = body.library_folder_id ?? null;
    if (folder) {
      const row = this.ctx.db.get<{ kind: string }>('SELECT kind FROM library_node WHERE id = ? AND deleted_at IS NULL', [folder]);
      if (!row || row.kind === 'notebook') throw validation('library_folder_id', 'اختر مجلدًا من مكتبتك لتظهر فيه محاضرات المادة (الدفتر لا يصلح لذلك).');
    }
    return courseFollowView(this.repo.upsertCourseFollow(viewer.userId, subjectId, body.add_new_lectures, folder), node);
  }

  /** Unfollow: always the viewer's own follow, idempotent; what the library already holds stays (links, not copies). */
  unfollow(viewer: Viewer, subjectId: string): CourseUnfollowResponse {
    this.assert(viewer, 'view', { type: 'channel_node', id: subjectId });
    const node = this.existing(subjectId);
    this.repo.endCourseFollow(viewer.userId, subjectId);
    return { subject: nodeRef(node), course_follow: null };
  }

  // ───────────────────────── notices (P1-T4 step 2) ─────────────────────────

  /**
   * A pending request: the node's approvers (Admins / Assistants here or above; the platform admins when there are
   * none) — each still allowed to manage the node's members when the row is written and when it is read. A request is
   * published once per transition to pending (asking again while pending publishes nothing), hence a fresh key.
   */
  private notifyJoinRequest(node: NodeRow, m: MembershipRow): void {
    notificationsOf(this.ctx).publish({
      content: { kind: 'join_requested', payload: { node_title: node.title, pending_count: this.repo.pendingCount(node.id) } },
      actorUserId: m.user_id,
      target: { db: 'system', type: 'channel_node', id: node.id },
      scopeNodeId: node.id,
      access: 'manage_members',
      dedupeKey: `join_requested:${m.id}:${newId(this.now())}`,
      audience: { kind: 'node_approvers', node_id: node.id },
      exclude: [m.user_id],
    });
  }

  /** A decision about someone's membership: that person, with who decided (a repeated decision changes nothing and says nothing). */
  private notifyDecision(node: NodeRow, m: MembershipRow, by: Viewer): void {
    const decision = m.status === 'approved' ? 'approved' : m.status === 'rejected' ? 'rejected' : 'removed';
    notificationsOf(this.ctx).publish({
      content: { kind: 'join_decided', payload: { node_title: node.title, decision } },
      actorUserId: by.userId,
      target: { db: 'system', type: 'channel_node', id: node.id },
      dedupeKey: `join_decided:${m.id}:${newId(this.now())}`,
      audience: { kind: 'users', user_ids: [m.user_id] },
    });
  }

  /** Account deletion participant: memberships end, roles and pending invitations are revoked, follows end. */
  forgetUser(userId: string): void {
    this.ctx.system.db.tx(() => this.repo.forgetUser(userId));
  }

  /** The people a list names (tests, views of later steps). */
  peopleOf(ids: string[]): Map<string, PersonRow> {
    return this.repo.people(ids);
  }
}

const instances = new WeakMap<object, ChannelService>();

/** The channels service of an application context (created on first use, shared by the plugin and the verifier). */
export function channelsOf(ctx: AppContext): ChannelService {
  let s = instances.get(ctx.system);
  if (!s) {
    s = new ChannelService(ctx);
    instances.set(ctx.system, s);
  }
  return s;
}
