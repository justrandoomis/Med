// Account deletion (P1-T1 step 2; ADR-0003 §3.6, §7 Q14; PRD AOS-21.44, Q14 default).
//
//   POST /api/accounts/me/delete {preview: true}               → DeletionPreview (counts of MY vault, the policy, a token)
//   POST /api/accounts/me/delete {confirm_token, password}     → {status} — the password confirms it is really me
//
// Policy (PRD Q14 default): the vault and every private datum in it are deleted; the account row stays only as an
// anonymous «طالب سابق» (login name freed, password and recovery codes unusable, profile cleared — names are rendered
// at read time, so it shows that way everywhere at once). Publications arrive with P1-T5, which registers a deletion
// participant (withdraw from listings; forks others already made are not erased, and the preview says so). No one —
// the platform admin included — can delete or edit another user's data through this flow. The last active platform
// admin cannot delete their account (the deployment would have no administrator).
//
// Order (each step idempotent, so a crash resumes): (1) one system transaction marks the account `deletion_pending`
// and its vault `deleting` (nothing can bind it any more) and revokes every session; (2) deletion participants run;
// (3) once no request or job holds the vault, its file, its exports and its upload sessions are removed, its blob
// hints and job-index entries dropped, its devices deleted; (4) the vault is marked `deleted` and the account
// anonymised. Blob bytes are left to the mark-and-sweep GC (other accounts may share them). Whole-instance backups made
// before the deletion still contain the vault until their retention removes them (the preview says so).
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ACCOUNTS_LABELS_AR, type DeletionPreview } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import { hmacSha256, safeEqual } from '../../lib/hash';
import { deriveKey, loadOrCreateServerSecret } from '../../lib/secret';
import type { Viewer } from '../../system/binding';
import { verifySecret } from '../auth/password';
import { exportsDir } from './export';

export const DELETION_TOKEN_TTL_MS = 15 * 60 * 1000;

export const DELETION_POLICY_AR = [
  'تُحذف خزنتك كلها: مكتبتك وملفاتك وملاحظاتك وحبرك وبطاقاتك وتسجيلاتك وإعداداتك وسجلّك. لا يمكن التراجع بعد التأكيد.',
  'تختفي ملفاتك من حسابك فورًا، أما محتواها فيُمحى من مخزن الملفات (ومن نسخته المشفّرة في التخزين السحابي إن وُجدت) خلال نحو ستة أسابيع: يُفحص المخزن مرتين بينهما أسبوع، ثم يبقى الملف في الحجر 30 يومًا قبل حذفه، حتى لا يُحذف ملف ما زال حساب آخر يستخدم المحتوى نفسه.',
  'تُحذف جلساتك وأجهزتك ومحاولات الدخول المسجلة باسم دخولك.',
  'يبقى اسمك في أي مكان ظهر فيه باسم «طالب سابق»؛ لا يبقى اسم الدخول ولا الملف الشخصي.',
  'ما نشرته يُسحب من القوائم (حين تتوفر المنشورات). النسخ التي أخذها غيرك سابقًا لا تُمحى: لا يستطيع أحد — ولا المشرفون — تعديل طبقات مستخدم آخر.',
  'النسخ الاحتياطية الكاملة للخادم التي سبقت الحذف تبقى حتى تنتهي مدة الاحتفاظ بها ثم تُحذف.',
  'نزّل «نسخة من بياناتي» أولًا إن أردت الاحتفاظ ببياناتك.',
];

export interface AccountDeletionParticipant {
  name: string;
  /** remove or withdraw this account's shared items; must be idempotent (a crash re-runs it) */
  run(ctx: AppContext, who: { userId: string; vaultId: string | null }): void | Promise<void>;
}

const participants = new WeakMap<object, Map<string, AccountDeletionParticipant>>();

/** Later tracks (P1-T5 publications) register what deleting an account must also do, from their own plugin. */
export function registerAccountDeletionParticipant(ctx: AppContext, p: AccountDeletionParticipant): void {
  let m = participants.get(ctx.system);
  if (!m) participants.set(ctx.system, (m = new Map()));
  m.set(p.name, p);
}

function tokenKey(ctx: AppContext): Buffer {
  return deriveKey(loadOrCreateServerSecret(ctx.config.dataDir), 'account-deletion');
}

function sign(ctx: AppContext, userId: string, expiresAt: number): string {
  const payload = Buffer.from(JSON.stringify({ u: userId, e: expiresAt })).toString('base64url');
  return `${payload}.${hmacSha256(tokenKey(ctx), payload).toString('base64url')}`;
}

function verifyToken(ctx: AppContext, token: string, userId: string): boolean {
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), hmacSha256(tokenKey(ctx), payload).toString('base64url'))) return false;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { u?: unknown; e?: unknown };
    return d.u === userId && typeof d.e === 'number' && ctx.clock.now() < d.e;
  } catch {
    return false;
  }
}

const count = (ctx: AppContext, table: string, where = '') => {
  try {
    return ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}" ${where}`)?.n ?? 0;
  } catch {
    return 0;
  }
};

function blockedReason(ctx: AppContext, viewer: Viewer): string | null {
  const me = ctx.system.users.me(viewer);
  if (me?.is_platform_admin === 1 && me.status === 'active' && ctx.system.users.otherActiveAdminsInternal(viewer.userId) === 0) return ACCOUNTS_LABELS_AR.delete_last_admin;
  return null;
}

/** What deleting MY account removes (counts of the bound vault), and the token that confirms it. */
export function deletionPreview(ctx: AppContext, viewer: Viewer): DeletionPreview {
  const vault = ctx.system.vaults.ofViewer(viewer);
  const used = vault ? ctx.quota.storageUsed(vault.id) : { bytes_db: 0, bytes_files: 0 };
  const expiresAt = ctx.clock.now() + DELETION_TOKEN_TTL_MS;
  return {
    vault: {
      sources: count(ctx, 'source'),
      annotations: count(ctx, 'annotation', 'WHERE deleted_at IS NULL'),
      notes: count(ctx, 'note', 'WHERE deleted_at IS NULL'),
      recordings: count(ctx, 'audio_recording'),
      cards: count(ctx, 'flashcard', 'WHERE deleted_at IS NULL'),
      bytes: used.bytes_db + used.bytes_files,
    },
    publications: { total: 0, forked_by_others: 0 },
    policy_ar: DELETION_POLICY_AR,
    confirm_token: sign(ctx, viewer.userId, expiresAt),
    expires_at: expiresAt,
    blocked_ar: blockedReason(ctx, viewer),
  };
}

/** Confirm the deletion of MY account (token + password), then finish it in the background. */
export async function confirmDeletion(ctx: AppContext, viewer: Viewer, body: { confirm_token: string; password: string }, ip: string | null): Promise<{ status: 'deletion_pending' }> {
  if (!verifyToken(ctx, body.confirm_token, viewer.userId)) throw new AppError('CONFLICT', ACCOUNTS_LABELS_AR.delete_token, 409);
  const me = ctx.system.users.me(viewer);
  if (!me || me.status !== 'active') throw new AppError('UNAUTHENTICATED', 'يلزم تسجيل الدخول للمتابعة.', 401);
  if (!(await verifySecret(body.password, me.password_hash))) throw new AppError('FORBIDDEN', ACCOUNTS_LABELS_AR.delete_password, 403);
  const blocked = blockedReason(ctx, viewer);
  if (blocked) throw new AppError('CONFLICT', blocked, 409);
  const vault = ctx.system.vaults.ofViewer(viewer);
  ctx.system.db.tx(() => {
    ctx.system.users.markDeletionPendingInternal(viewer.userId);
    if (vault) ctx.system.vaults.setStatusInternal(vault.id, 'deleting');
    ctx.system.sessions.revokeAllExcept(viewer.userId, null);
  });
  ctx.system.securityAudit.record({ actorUserId: viewer.userId, actorRole: 'self', action: 'account_delete', targetDb: vault?.id ?? null, targetType: 'account', targetId: viewer.userId, summary: 'طلب حذف الحساب', ip });
  // after this response: the request's own lease on the vault is released first
  ctx.binding.runRoot(() => setImmediate(() => void finishPendingDeletions(ctx).catch((e: unknown) => ctx.log.warn({ err: e }, 'account deletion will be retried'))));
  return { status: 'deletion_pending' };
}

const finishing = new WeakMap<object, Promise<number>>();

/** Finish every deletion that is pending (after the request, at boot, and from the maintenance timer). */
export function finishPendingDeletions(ctx: AppContext): Promise<number> {
  const running = finishing.get(ctx.system);
  if (running) return running;
  const p = (async () => {
    let done = 0;
    for (const user of ctx.system.users.pendingDeletionsInternal()) {
      const vault = ctx.system.vaults.ofUserInternal(user.id);
      const vaultId = vault && vault.status !== 'deleted' ? vault.id : null;
      try {
        for (const p of participants.get(ctx.system)?.values() ?? []) await p.run(ctx, { userId: user.id, vaultId });
      } catch (e) {
        ctx.log.warn({ err: e, user: user.id }, 'an account-deletion participant failed; the deletion is retried later');
        continue;
      }
      if (vaultId && vault) {
        if (!ctx.pool.close('vault', vaultId)) continue; // a request or job still holds it: next time
        const path = ctx.pool.pathOfFile('vault', vault.db_file);
        for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
        rmSync(exportsDir(ctx, vaultId), { recursive: true, force: true });
        rmSync(join(ctx.config.dataDir, 'backups', 'vaults', vaultId), { recursive: true, force: true });
        for (const s of ctx.system.uploads.ofUserInternal(user.id)) rmSync(join(ctx.config.tmpDir, 'uploads', s.id), { recursive: true, force: true });
        ctx.system.db.tx(() => {
          ctx.system.uploads.deleteAllInternal(user.id); // their rows hold file names (P1-T1 step 2 review)
          ctx.system.blobs.dropDatabaseInternal(vaultId);
          ctx.system.jobIndex.removeDbInternal(vaultId);
          ctx.system.vaults.setStatusInternal(vaultId, 'deleted');
        });
      }
      ctx.system.db.tx(() => {
        ctx.system.uploads.deleteAllInternal(user.id);
        ctx.system.devices.deleteAllInternal(user.id);
        // also removes the account's sessions and the sign-in attempts under its old login name
        ctx.system.users.finalizeDeletionInternal(user.id);
      });
      ctx.system.securityAudit.record({ actorUserId: user.id, actorRole: 'self', action: 'account_deleted', targetDb: vaultId, targetType: 'account', targetId: user.id, summary: 'اكتمل حذف الحساب' });
      done++;
    }
    return done;
  })().finally(() => {
    finishing.delete(ctx.system);
  });
  finishing.set(ctx.system, p);
  return p;
}
