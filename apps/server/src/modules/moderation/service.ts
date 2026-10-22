// The minimal moderation flow (P1-T4 step 2; ARCHITECTURE_DELTA §4.1 `2310_moderation`, §7.12, §13, §5.3; PRD AOS-18.7,
// 18.8 Phase 1 parts, Q6 — course-only publications go live at once, so something must stand behind them):
//   report (any member who can see the content; one OPEN report per reporter per target; 20 an hour per account)
//   → the queue of the content's subject (its moderators: Admin / Assistant / Subject Moderator here or above, and the
//     platform admin; anyone else gets the 404 of a missing route)
//   → hide / restore / dismiss with an Arabic reason (`moderate` on the subject; never on one's own content)
//   → the author and the reporter are told (the notice never names the reporter, nor the moderator: it speaks for the
//     role) → a `moderation_action` row and a scoped `security_audit` entry (no note, no reporter, no IP).
// The content belongs to its owner track and is reached only through the target registry (targets.ts).
// This file is the only one of the module that holds the system DB handle (import-boundary test).
import {
  type CreateReportRequest,
  MODERATION_ACTION_LABELS_AR,
  type ModerationActionRequest,
  type ModerationActionView,
  type ModerationTarget,
  type NodeRef,
  type ReportQueueResponse,
  type ReportStatus,
  type ReportView,
  type SecurityAuditResponse,
  type SecurityAuditView,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AppError, Errors } from '../../lib/errors';
import { newId } from '../../lib/ids';
import type { Viewer } from '../../system/binding';
import { MODERATING_ROLES } from '../channels/access';
import { channelsOf } from '../channels/service';
import { nodeRef, userRef } from '../channels/views';
import { isNotificationLink, notificationsOf } from '../notifications/service';
import { type ModerationTargetHandler, type ModerationTargetInfo, moderationTargetsOf } from './targets';

export const REPORTS_PER_HOUR = 20;
const HOUR = 60 * 60_000;

const NOT_FOUND_AR = 'العنصر غير موجود.';
/** what Fastify answers for a route that does not exist */
const MISSING_ROUTE_AR = 'المسار المطلوب غير موجود.';
const notFound = () => new AppError('NOT_FOUND', NOT_FOUND_AR, 404);
const validation = (path: string, message: string) => new AppError('VALIDATION_FAILED', message, 400, { where: 'body', issues: [{ path, code: 'custom', message }] });

interface ReportRow {
  id: string;
  reporter_user_id: string;
  target_db: string;
  target_type: ModerationTarget['type'];
  target_id: string;
  scope_node_id: string;
  reason: ReportView['reason'];
  note: string | null;
  status: ReportStatus;
  created_at: number;
  resolved_at: number | null;
}

const targetOf = (r: Pick<ReportRow, 'target_db' | 'target_type' | 'target_id'>): ModerationTarget => ({ db: r.target_db, type: r.target_type, id: r.target_id });
const sameTarget = (a: ModerationTarget, b: ModerationTarget) => a.db === b.db && a.type === b.type && a.id === b.id;

export class ModerationService {
  constructor(private readonly ctx: AppContext) {}

  private get db() {
    return this.ctx.system.db;
  }

  private get channels() {
    return channelsOf(this.ctx);
  }

  private resolve(target: ModerationTarget): { handler: ModerationTargetHandler; info: ModerationTargetInfo | null } | null {
    const handler = moderationTargetsOf(this.ctx).handler(target.type);
    if (!handler) return null;
    return { handler, info: handler.resolve(target) };
  }

  private mayModerate(viewer: Viewer, scopeNodeId: string): boolean {
    return this.ctx.authz.can(viewer, 'moderate', { type: 'channel_node', id: scopeNodeId }).allowed;
  }

  /** The role the viewer moderates this scope with: the platform admin, else the nearest moderating role (and where it is held). */
  private actingRole(viewer: Viewer, scopeNodeId: string): { role: ModerationActionView['role']; auditRole: string } {
    if (viewer.isPlatformAdmin) return { role: 'platform_admin', auditRole: 'platform_admin' };
    const r = this.channels.access.effective(viewer, scopeNodeId)?.roles.find((x) => MODERATING_ROLES.includes(x.role));
    if (!r) throw notFound();
    return { role: r.role, auditRole: `${r.role}@${r.nodeId}` };
  }

  private scopeRef(nodeId: string): NodeRef {
    const n = this.channels.repo.node(nodeId);
    return n ? nodeRef(n) : { id: nodeId, kind: 'subject', title: '' };
  }

  /**
   * `reporterVisible`: the moderators of the scope read who reported; `noteVisible`: they and the reporter read the
   * note. A moderator who wrote the reported content reads neither — the note is the reporter's own words and may name
   * them (review P1-T4 step 2, R2).
   */
  private view(r: ReportRow, title: string | null, reporterVisible: boolean, noteVisible = reporterVisible): ReportView {
    const people = reporterVisible ? this.channels.peopleOf([r.reporter_user_id]) : new Map();
    return {
      id: r.id,
      target: { ...targetOf(r), title },
      scope: this.scopeRef(r.scope_node_id),
      reason: r.reason,
      note: noteVisible ? r.note : null,
      status: r.status,
      created_at: r.created_at,
      resolved_at: r.resolved_at,
      reporter: reporterVisible ? userRef(r.reporter_user_id, people) : null,
    };
  }

  // ───────────────────────── reports ─────────────────────────

  createReport(viewer: Viewer, body: CreateReportRequest): ReportView {
    const target = body.target as ModerationTarget;
    const found = this.resolve(target);
    // a type nobody registered, content that does not exist, or content the reporter cannot see: one and the same 404
    if (!found?.info || !found.handler.visibleTo(viewer, target, found.info)) throw notFound();
    const info = found.info;
    if (info.authorUserId === viewer.userId) throw new AppError('CONFLICT', 'هذا محتواك: يمكنك تعديله أو سحبه بدلًا من الإبلاغ عنه.', 409);
    const now = this.ctx.clock.now();
    const recent = this.db.all<{ created_at: number }>('SELECT created_at FROM moderation_report WHERE reporter_user_id = ? AND created_at > ? ORDER BY created_at LIMIT ?', [viewer.userId, now - HOUR, REPORTS_PER_HOUR]);
    if (recent.length >= REPORTS_PER_HOUR) throw Errors.rateLimited((recent[0]!.created_at + HOUR - now) / 1000, 'أرسلت بلاغات كثيرة خلال ساعة. انتظر قليلًا ثم أعد المحاولة؛ المشرفون يراجعون بلاغاتك السابقة.');
    const open = this.db.get<{ id: string }>(`SELECT id FROM moderation_report WHERE reporter_user_id = ? AND target_db = ? AND target_type = ? AND target_id = ? AND status = 'open'`, [
      viewer.userId,
      target.db,
      target.type,
      target.id,
    ]);
    const already = () => new AppError('CONFLICT', 'أبلغت عن هذا المحتوى من قبل، وبلاغك قيد المراجعة.', 409, { report_id: open?.id ?? null });
    if (open) throw already();
    const id = newId(now);
    const scope = this.scopeRef(info.scopeNodeId);
    try {
      this.db.tx(() => {
        this.db.run(
          `INSERT INTO moderation_report (id, reporter_user_id, target_db, target_type, target_id, scope_node_id, reason, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
          [id, viewer.userId, target.db, target.type, target.id, info.scopeNodeId, body.reason, body.note ?? null, now],
        );
        const openInScope = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM moderation_report WHERE scope_node_id = ? AND status = 'open'`, [info.scopeNodeId])!.n;
        // the subject's moderators and assistants (and Admins above) — never the reporter, never the author
        notificationsOf(this.ctx).publish({
          content: { kind: 'report_received', payload: { subject_title: scope.title, target_title: info.title, reason: body.reason, open_reports: openInScope } },
          target: { db: 'system', type: 'moderation_report', id },
          scopeNodeId: info.scopeNodeId,
          access: 'moderate',
          dedupeKey: `report_received:${id}`,
          audience: { kind: 'scope_moderators', node_id: info.scopeNodeId },
          exclude: [viewer.userId, ...(info.authorUserId ? [info.authorUserId] : [])],
        });
      });
    } catch (e) {
      // a second tab racing the first: the unique index on OPEN reports answers like the check above
      if (e instanceof Error && /UNIQUE|constraint/i.test(e.message)) throw already();
      throw e;
    }
    // the reporter reads their own report back: the note, never a name
    return this.view(this.report(id)!, info.title, false, true);
  }

  private report(id: string): ReportRow | null {
    return this.db.get<ReportRow>('SELECT * FROM moderation_report WHERE id = ?', [id]) ?? null;
  }

  /** The queue of a scope: its reports and those of every node below it, newest first. Moderators of the scope only. */
  queue(viewer: Viewer, q: { scope_node_id: string; status?: ReportStatus; cursor?: string; limit: number }): ReportQueueResponse {
    // not a moderator here (or no such node): exactly the body of a missing route — the queue does not exist for them
    if (!this.mayModerate(viewer, q.scope_node_id)) throw new AppError('NOT_FOUND', MISSING_ROUTE_AR, 404);
    let after: { created_at: number; id: string } | null = null;
    if (q.cursor) {
      try {
        const v = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')) as unknown;
        if (!Array.isArray(v) || typeof v[0] !== 'number' || typeof v[1] !== 'string') throw new Error('cursor');
        after = { created_at: v[0], id: v[1] };
      } catch {
        throw new AppError('VALIDATION_FAILED', 'مؤشر الصفحة غير صالح.', 400, { where: 'query', issues: [{ path: 'cursor', code: 'custom', message: 'مؤشر الصفحة غير صالح.' }] });
      }
    }
    const where = ['c.ancestor_id = ?'];
    const params: (string | number)[] = [q.scope_node_id];
    if (q.status) {
      where.push('r.status = ?');
      params.push(q.status);
    }
    if (after) {
      where.push('(r.created_at < ? OR (r.created_at = ? AND r.id < ?))');
      params.push(after.created_at, after.created_at, after.id);
    }
    const rows = this.db.all<ReportRow>(
      `SELECT r.* FROM moderation_report r JOIN channel_closure c ON c.descendant_id = r.scope_node_id
        WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
      [...params, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const items = page.map((r) => {
      const info = this.resolve(targetOf(r))?.info ?? null;
      // the author never learns who reported them — a moderator who wrote the content included. Content that no longer
      // resolves has no known author any more (its author may be the one asking), so its reporter and note are shown to
      // nobody; the report can still be dismissed (review P1-T4 step 2, R5)
      return this.view(r, info?.title ?? null, !!info && info.authorUserId !== viewer.userId);
    });
    const last = page[page.length - 1];
    return { items, next_cursor: rows.length > q.limit && last ? Buffer.from(JSON.stringify([last.created_at, last.id])).toString('base64url') : null };
  }

  // ───────────────────────── actions ─────────────────────────

  act(viewer: Viewer, body: ModerationActionRequest, ip: string | null): ModerationActionView {
    const report = body.report_id ? this.report(body.report_id) : null;
    if (body.report_id && !report) throw notFound();
    const target: ModerationTarget = report ? targetOf(report) : (body.target as ModerationTarget);
    if (report && body.target && !sameTarget(targetOf(report), body.target as ModerationTarget)) throw validation('target', 'البلاغ يخص محتوى آخر غير المذكور في الطلب.');
    const found = this.resolve(target);
    if (!found) throw notFound();
    const { handler, info } = found;
    // the subject the content belongs to NOW decides who moderates it; the report's scope (the subject when it was
    // filed) only stands in once the content is gone (review P1-T4 step 2, R3)
    const scopeNodeId = info?.scopeNodeId ?? report?.scope_node_id ?? null;
    if (!scopeNodeId) throw notFound();
    if (!this.mayModerate(viewer, scopeNodeId)) {
      // a member who can see the content may know it exists: 403; a report id, or content they cannot see: 404
      if (!report && info && handler.visibleTo(viewer, target, info)) throw new AppError('FORBIDDEN', 'الإشراف على المحتوى لمشرفي المادة ومساعديها فقط.', 403);
      throw notFound();
    }
    if (info?.authorUserId === viewer.userId) throw new AppError('FORBIDDEN', 'لا يمكنك اتخاذ قرار إشرافي في محتواك؛ يقرر فيه مشرف آخر.', 403);

    const openOnTarget = () =>
      this.db.all<ReportRow>(`SELECT * FROM moderation_report WHERE target_db = ? AND target_type = ? AND target_id = ? AND status = 'open' ORDER BY created_at, id`, [target.db, target.type, target.id]);
    let closing: ReportRow[] = [];
    let closeAs: ReportStatus = 'actioned';
    switch (body.action) {
      case 'hide':
        if (!info) throw notFound();
        if (info.state === 'hidden') throw new AppError('CONFLICT', 'هذا المحتوى مخفي بالفعل.', 409);
        closing = openOnTarget();
        closeAs = 'actioned';
        break;
      case 'restore':
        if (!info) throw notFound();
        if (info.state === 'visible') throw new AppError('CONFLICT', 'هذا المحتوى ظاهر بالفعل.', 409);
        closing = report && report.status === 'open' ? [report] : [];
        closeAs = 'dismissed';
        break;
      case 'dismiss':
        if (report) {
          if (report.status !== 'open') throw new AppError('CONFLICT', 'هذا البلاغ مغلق بالفعل.', 409);
          closing = [report];
        } else {
          closing = openOnTarget();
          if (closing.length === 0) throw new AppError('CONFLICT', 'لا توجد بلاغات مفتوحة على هذا المحتوى.', 409);
        }
        closeAs = 'dismissed';
        break;
    }

    const { role, auditRole } = this.actingRole(viewer, scopeNodeId);
    const now = this.ctx.clock.now();
    const actionId = newId(now);
    const scope = this.scopeRef(scopeNodeId);
    const title = info?.title ?? 'محتوى محذوف';
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO moderation_action (id, report_id, moderator_user_id, role, action, target_db, target_type, target_id, scope_node_id, reason_ar, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [actionId, report?.id ?? null, viewer.userId, role, body.action, target.db, target.type, target.id, scopeNodeId, body.reason_ar, now],
      );
      for (const r of closing) this.db.run(`UPDATE moderation_report SET status = ?, resolved_at = ? WHERE id = ? AND status = 'open'`, [closeAs, now, r.id]);
      this.ctx.system.securityAudit.record({
        actorUserId: viewer.userId,
        actorRole: auditRole,
        scopeNodeId,
        action: `moderation_${body.action}`,
        targetDb: target.db,
        targetType: target.type,
        targetId: target.id,
        // no reason text, no reporter, no note: the summary says what was done where
        summary: `${MODERATION_ACTION_LABELS_AR[body.action]} — في «${scope.title}»`,
        details: { action_id: actionId, report_id: report?.id ?? null, reports_closed: closing.length },
        ip,
      });
      this.notifyOutcome(body.action, actionId, scopeNodeId, info, title, body.reason_ar, closing, viewer, report);
      // the owner's storage last: if it refuses, nothing above happened
      if (body.action === 'hide' || body.action === 'restore') handler.setState(target, body.action === 'hide' ? 'hidden' : 'visible', { userId: viewer.userId, reasonAr: body.reason_ar, actionId });
    });
    return {
      id: actionId,
      report_id: report?.id ?? null,
      action: body.action,
      target,
      reason_ar: body.reason_ar,
      moderator: userRef(viewer.userId, this.channels.peopleOf([viewer.userId])),
      role,
      created_at: now,
    };
  }

  /**
   * hide → the author and the reporters of the reports it closed; restore → the author (and the reporter of the report
   * named, if any); dismiss → the reporters only (a dismissed report says nothing to the author). Never the moderator,
   * never the author as a reporter; the notice has no actor (it speaks for the role). The author's notice is theirs
   * whatever happens to their membership (it is about their own content); a reporter's is shown only while they may
   * still enter the subject (access `member`) — someone who left learns nothing more about its content.
   */
  private notifyOutcome(action: ModerationActionRequest['action'], actionId: string, scopeNodeId: string, info: ModerationTargetInfo | null, title: string, reasonAr: string, closed: ReportRow[], viewer: Viewer, report: ReportRow | null): void {
    const svc = notificationsOf(this.ctx);
    const author = info?.authorUserId ?? null;
    const ownerLink = info?.link ?? null;
    const base = { target_title: title, action, reason_ar: reasonAr };
    if (author && action !== 'dismiss' && author !== viewer.userId) {
      svc.publish({
        content: { kind: 'moderation', payload: { ...base, as: 'author' } },
        // the owner track's link only when it is an in-app path: a notice never stops a decision (review P1-T4 step 2, R4)
        link: isNotificationLink(ownerLink) ? ownerLink : null,
        dedupeKey: `moderation:${actionId}:author`,
        audience: { kind: 'users', user_ids: [author] },
      });
    }
    const reporters = action === 'restore' ? (report ? [report.reporter_user_id] : []) : closed.map((r) => r.reporter_user_id);
    const told = [...new Set(reporters)].filter((id) => id !== author && id !== viewer.userId);
    if (told.length > 0) {
      svc.publish({
        content: { kind: 'moderation', payload: { ...base, as: 'reporter' } },
        link: null,
        access: 'member',
        scopeNodeId,
        dedupeKey: `moderation:${actionId}:reporter`,
        audience: { kind: 'users', user_ids: told },
      });
    }
  }
}

// ───────────────────────── the scoped security-audit view ─────────────────────────

interface AuditRow {
  id: string;
  actor_user_id: string | null;
  actor_role: string | null;
  scope_node_id: string | null;
  action: string;
  target_db: string | null;
  target_type: string | null;
  target_id: string | null;
  summary: string;
  created_at: number;
}

/**
 * `GET /api/admin/audit` (ARCHITECTURE_DELTA §7.12, §13, §5.3 «scoped audit: Assistant subtree, Admin subtree, platform
 * admin all; Subject Moderator own subject (aggregates — Phase 2)»; PRD AOS-18.14, 21.33): the `security_audit` rows whose
 * scope is the node or anything below it (one closure join), newest first, optionally one action. What leaves the server
 * is the contract's SecurityAuditView — actor, actor role, scope, action, target, the Arabic summary each module wrote
 * without private content, the time — never the IP address, never `details_json`. Rows without a scope (sign-ins,
 * devices, exports) never appear in a scoped view.
 */
export function scopedAudit(ctx: AppContext, viewer: Viewer, q: { scope_node_id: string; action?: string; cursor?: string; limit: number }): SecurityAuditResponse {
  // a missing node → 404; a node the viewer may not audit → 403 (nodes are visible to every signed-in user)
  ctx.authz.assert(viewer, 'view_audit', { type: 'channel_node', id: q.scope_node_id });
  let after: { created_at: number; id: string } | null = null;
  if (q.cursor) {
    try {
      const v = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')) as unknown;
      if (!Array.isArray(v) || typeof v[0] !== 'number' || typeof v[1] !== 'string') throw new Error('cursor');
      after = { created_at: v[0], id: v[1] };
    } catch {
      throw new AppError('VALIDATION_FAILED', 'مؤشر الصفحة غير صالح.', 400, { where: 'query', issues: [{ path: 'cursor', code: 'custom', message: 'مؤشر الصفحة غير صالح.' }] });
    }
  }
  const where = ['c.ancestor_id = ?'];
  const params: (string | number)[] = [q.scope_node_id];
  if (q.action) {
    where.push('a.action = ?');
    params.push(q.action);
  }
  if (after) {
    where.push('(a.created_at < ? OR (a.created_at = ? AND a.id < ?))');
    params.push(after.created_at, after.created_at, after.id);
  }
  const rows = ctx.system.db.all<AuditRow>(
    `SELECT a.id, a.actor_user_id, a.actor_role, a.scope_node_id, a.action, a.target_db, a.target_type, a.target_id, a.summary, a.created_at
       FROM security_audit a JOIN channel_closure c ON c.descendant_id = a.scope_node_id
      WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
    [...params, q.limit + 1],
  );
  const page = rows.slice(0, q.limit);
  const channels = channelsOf(ctx);
  const people = channels.peopleOf(page.map((r) => r.actor_user_id).filter((x): x is string => !!x));
  const nodes = new Map(channels.repo.nodesByIds([...new Set(page.map((r) => r.scope_node_id).filter((x): x is string => !!x))]).map((n) => [n.id, n]));
  const items: SecurityAuditView[] = page.map((r) => {
    const node = r.scope_node_id ? nodes.get(r.scope_node_id) : undefined;
    return {
      id: r.id,
      actor: r.actor_user_id ? userRef(r.actor_user_id, people) : null,
      actor_role: r.actor_role,
      scope: node ? nodeRef(node) : null,
      action: r.action,
      target: r.target_type && r.target_id ? { db: r.target_db ?? 'system', type: r.target_type, id: r.target_id } : null,
      summary_ar: r.summary,
      created_at: r.created_at,
    };
  });
  const last = page[page.length - 1];
  return { items, next_cursor: rows.length > q.limit && last ? Buffer.from(JSON.stringify([last.created_at, last.id])).toString('base64url') : null };
}

const instances = new WeakMap<object, ModerationService>();

export function moderationOf(ctx: AppContext): ModerationService {
  let s = instances.get(ctx.system);
  if (!s) {
    s = new ModerationService(ctx);
    instances.set(ctx.system, s);
  }
  return s;
}
