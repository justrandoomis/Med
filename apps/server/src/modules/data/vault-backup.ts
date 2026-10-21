// Per-vault backups and the vault restore (P1-T1 step 2; ADR-0003 §3.6, ARCHITECTURE_DELTA §5.8). Platform-admin
// operations: the admin starts them, but no route ever shows the admin a vault's content — only file names, sizes and
// the verification checks.
//
// A per-vault backup is the archive of ONE vault and the files it references (layout 'vault'), encrypted with
// «MLVENC01» when MEDLEVO_BACKUP_ENCRYPTION_KEY is set (the plain archive never stays on disk), kept in
// DATA_DIR/backups/vaults/<vault id>/. Restoring one restores ONE user, in place, on the running server:
//   1. the archive is verified first in a separate directory (decrypt, hashes, integrity, row counts, boot on a sandbox);
//      nothing changes unless every check passes, and it must be THIS vault's archive;
//   2. the vault is locked (its user's requests are told the account is under maintenance) and its connection closed
//      once no request or job is using it;
//   3. the current vault file is kept as a rollback copy beside the backups, then the restored file takes its place
//      atomically; files the vault references that the store lacks are put back from the archive;
//   4. that vault starts a new sync epoch (only that user's devices reset their cursor) and that user's sessions are
//      revoked — other accounts are not touched;
//   5. the vault is unlocked, its job index reconciled, and a blob mark pass rebuilds the hints.
// Any failure after the lock puts the previous file back and unlocks.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { VaultBackupView, VaultRestoreResponse } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { openDb } from '../../db/db';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { encryptArchive, ENC_SUFFIX } from './archive-crypto';
import { createBackup } from './backup';
import { startRestoreEpoch } from './epoch';
import { verifyBackup } from './restore';

export const VAULT_BACKUP_NAME_RE = /^medlevo-vault-[0-9TZ-]+-[0-9a-z]{8}\.tar\.gz(\.mlenc)?$/;

export const VAULT_BACKUP_NOTE_AR =
  'نسخة خزنة حساب واحد وملفاته، تُحفظ على قرص الخادم مشفّرة (MLVENC01) متى ضُبط مفتاح التشفير. الاستعادة تتحقق من النسخة أولًا في مجلد منفصل، وتحفظ الملف الحالي نسخةً للرجوع، ولا تمس الحسابات الأخرى؛ تُلغى جلسات صاحب الحساب وحده.';

export function vaultBackupsDir(ctx: AppContext, vaultId: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(vaultId)) throw new AppError('NOT_FOUND', 'الخزنة غير موجودة.', 404);
  return join(ctx.config.dataDir, 'backups', 'vaults', vaultId);
}

function liveVault(ctx: AppContext, vaultId: string) {
  const v = ctx.system.vaults.byIdInternal(vaultId);
  if (!v || v.status === 'deleted' || v.status === 'deleting') throw new AppError('NOT_FOUND', 'الخزنة غير موجودة.', 404);
  return v;
}

function viewOf(dir: string, name: string): VaultBackupView | null {
  if (!VAULT_BACKUP_NAME_RE.test(name)) return null;
  const p = join(dir, name);
  try {
    const st = statSync(p);
    const side = existsSync(`${p}.sha256`) ? readFileSync(`${p}.sha256`, 'utf8').split(/\s+/)[0] ?? '' : '';
    return { file_name: name, size: st.size, sha256: side, encrypted: name.endsWith(ENC_SUFFIX), created_at: Math.floor(st.mtimeMs) };
  } catch {
    return null;
  }
}

export function listVaultBackups(ctx: AppContext, vaultId: string): VaultBackupView[] {
  liveVault(ctx, vaultId);
  const dir = vaultBackupsDir(ctx, vaultId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((n) => viewOf(dir, n))
    .filter((v): v is VaultBackupView => v !== null)
    .sort((a, b) => b.file_name.localeCompare(a.file_name));
}

/** Make a per-vault backup (encrypted when the key is configured). */
export async function backupVault(ctx: AppContext, vaultId: string): Promise<VaultBackupView> {
  const v = liveVault(ctx, vaultId);
  const user = ctx.system.users.byIdInternal(v.user_id);
  const dir = vaultBackupsDir(ctx, vaultId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const work = join(ctx.config.tmpDir, `vault-backup-${newId(ctx.clock.now())}`);
  mkdirSync(work, { recursive: true, mode: 0o700 });
  try {
    const res = await createBackup({
      dataDir: ctx.config.dataDir,
      dbPath: ctx.config.dbPath,
      filesDir: ctx.config.filesDir,
      outDir: work,
      appVersion: ctx.config.appVersion,
      now: () => ctx.clock.now(),
      namePrefix: 'medlevo-vault',
      // a file whose local copy is missing is fetched back from the object store first (P1-T1 step 2 review)
      ensureLocal: (sha, size) => ctx.blobs.ensureLocal(sha, size),
      vaultOnly: {
        vault: { id: v.id, userId: v.user_id, dbFile: v.db_file, path: ctx.pool.pathOfFile('vault', v.db_file), primary: true },
        account: { user_id: v.user_id, username: user?.username ?? '', display_name: user?.display_name ?? '' },
      },
    });
    const key = ctx.config.secrets.backupEncryptionKey();
    let name = res.fileName;
    let sha = res.sha256;
    if (key) {
      name = `${res.fileName}${ENC_SUFFIX}`;
      sha = (await encryptArchive(res.archivePath, join(dir, name), key)).sha256;
      rmSync(res.archivePath, { force: true }); // the plain archive never stays on disk
    } else {
      renameSync(res.archivePath, join(dir, name));
    }
    writeFileSync(join(dir, `${name}.sha256`), `${sha}  ${name}\n`, { mode: 0o600 });
    return viewOf(dir, name)!;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The previous restore of each vault in this process (the route runs the restore in the background). */
export const lastVaultRestore = new Map<string, VaultRestoreResponse & { finished_at: number }>();

async function closeWhenIdle(ctx: AppContext, vaultId: string, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (ctx.pool.close('vault', vaultId)) return true;
    if (Date.now() >= until) return false;
    await sleep(100);
  }
}

/** Vaults with a restore in progress, per deployment (P1-T1 step 2 review: two restores at once both swapped the file). */
const restoring = new WeakMap<object, Set<string>>();

/** Restore ONE vault in place from one of its own backups (see the header). One restore per vault at a time. */
export async function restoreVault(ctx: AppContext, vaultId: string, fileName: string, o: { idleTimeoutMs?: number } = {}): Promise<VaultRestoreResponse> {
  const v = liveVault(ctx, vaultId);
  let running = restoring.get(ctx.system);
  if (!running) restoring.set(ctx.system, (running = new Set()));
  if (v.status !== 'active' || running.has(vaultId)) throw new AppError('CONFLICT', 'الخزنة في صيانة الآن؛ أعد المحاولة بعد قليل.', 409);
  running.add(vaultId);
  try {
    return await restoreVaultOnce(ctx, v, vaultId, fileName, o);
  } finally {
    running.delete(vaultId);
  }
}

async function restoreVaultOnce(
  ctx: AppContext,
  v: ReturnType<typeof liveVault>,
  vaultId: string,
  fileName: string,
  o: { idleTimeoutMs?: number },
): Promise<VaultRestoreResponse> {
  if (!VAULT_BACKUP_NAME_RE.test(fileName)) throw new AppError('NOT_FOUND', 'النسخة غير موجودة.', 404);
  const archive = join(vaultBackupsDir(ctx, vaultId), fileName);
  if (!existsSync(archive)) throw new AppError('NOT_FOUND', 'النسخة غير موجودة.', 404);

  const out = (ok: boolean, checks: VaultRestoreResponse['checks'], rollback: string | null, revoked: number): VaultRestoreResponse => ({
    vault_id: vaultId,
    ok,
    checks,
    rollback_copy: rollback ? basename(rollback) : null,
    sessions_revoked: revoked,
  });

  // 1. verify first, in a separate directory; keep the extracted copy
  mkdirSync(ctx.config.tmpDir, { recursive: true, mode: 0o700 });
  const res = await verifyBackup(archive, { workDir: ctx.config.tmpDir, keep: true, decryptionKey: ctx.config.secrets.backupEncryptionKey(), now: () => ctx.clock.now() });
  const checks = res.report.checks.map((c) => ({ name: c.name, ok: c.ok, detail_ar: c.detail_ar }));
  const m = res.manifest;
  const mine = m?.layout === 'vault' && m.vaults?.[0]?.vault_id === vaultId && m.vaults[0].user_id === v.user_id && m.vaults[0].db_file === v.db_file;
  if (!res.report.ok || !res.dataDir || !res.workDir || !mine) {
    if (res.workDir) rmSync(res.workDir, { recursive: true, force: true });
    if (res.report.ok && !mine) checks.push({ name: 'vault', ok: false, detail_ar: 'هذه النسخة ليست لهذه الخزنة؛ لم يتغير شيء.' });
    return out(false, checks, null, 0);
  }
  const staging = res.workDir;
  const restoredDb = join(res.dataDir, 'vaults', v.db_file);
  const livePath = ctx.pool.pathOfFile('vault', v.db_file);
  const t = ctx.clock.now();
  const rollback = join(vaultBackupsDir(ctx, vaultId), `pre-restore-${t}.sqlite`);
  const tmp = `${livePath}.restore-${t}.tmp`;
  let moved = false;

  // 2. lock and wait until nothing uses the vault
  ctx.system.vaults.setStatusInternal(vaultId, 'locked');
  try {
    if (!(await closeWhenIdle(ctx, vaultId, o.idleTimeoutMs ?? 15_000))) {
      checks.push({ name: 'apply', ok: false, detail_ar: 'الخزنة مستخدمة الآن (طلب أو مهمة جارية)؛ لم يتغير شيء. أعد المحاولة بعد قليل.' });
      return out(false, checks, null, 0);
    }
    // the restored copy sits beside the live file first (a crash while copying leaves the live file in place)
    copyFileSync(restoredDb, tmp);
    // P1-T1 step 2 review: a running sweep has read the OLD file; swapping under it would let it quarantine bytes the
    // restored vault uses. Wait until no sweep runs; from here to the mark pass below nothing awaits, so none starts.
    await ctx.gc.idle();
    // 3. keep the current file, then put the restored one in place (atomically, same filesystem)
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(`${livePath}${suffix}`)) renameSync(`${livePath}${suffix}`, `${rollback}${suffix}`);
    }
    moved = true;
    renameSync(tmp, livePath);
    // files the restored vault references that the store lacks (verified by sha256 during the check)
    const restoredFiles = join(res.dataDir, 'files');
    let blobsBack = 0;
    if (existsSync(restoredFiles)) {
      for (const a of readdirSync(restoredFiles)) {
        for (const b of readdirSync(join(restoredFiles, a))) {
          for (const sha of readdirSync(join(restoredFiles, a, b))) {
            const to = ctx.blobs.localPath(sha);
            if (existsSync(to)) continue;
            mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
            renameSync(join(restoredFiles, a, b, sha), to);
            blobsBack++;
          }
        }
      }
    }
    // 4. a new sync epoch for THIS vault; its user's sessions (and only theirs) are revoked
    const db = openDb(livePath);
    try {
      const epoch = startRestoreEpoch(db, { now: t, backupId: m!.backup_id, backupCreatedAt: m!.created_at });
      db.run(
        `INSERT INTO change_log (id, entity_type, entity_id, action, summary, after_json, actor, created_at) VALUES (?, 'server', 'data', 'restore', ?, ?, 'system', ?)`,
        [newId(t), `استُعيدت خزنتك من النسخة ${m!.backup_id}؛ بدأت حقبة مزامنة جديدة لأجهزتك.`, JSON.stringify({ backup_id: m!.backup_id, epoch: epoch.id, blobs_restored: blobsBack }), t],
      );
    } finally {
      db.close();
    }
    const revoked = ctx.system.sessions.revokeAllExcept(v.user_id, null);
    checks.push({ name: 'apply', ok: true, detail_ar: `استُعيدت الخزنة في مكانها، وبدأت حقبة مزامنة جديدة لها، وأُلغيت ${revoked} جلسة لصاحبها وحده. الملف السابق محفوظ للرجوع.` });
    // 5. unlock, reconcile, re-mark
    ctx.system.vaults.setStatusInternal(vaultId, 'active');
    ctx.jobs.reconcileIndex({ kind: 'vault', id: vaultId });
    void ctx.binding.runRoot(() => ctx.gc.run('mark')).catch(() => undefined);
    ctx.system.securityAudit.record({ actorUserId: null, actorRole: 'platform_admin', action: 'vault_restore', targetDb: vaultId, targetType: 'vault', targetId: vaultId, summary: 'استعادة خزنة حساب من نسخة', details: { backup_id: m!.backup_id, sessions_revoked: revoked } });
    return out(true, checks, rollback, revoked);
  } catch (e) {
    // put the previous file back
    if (moved) {
      ctx.pool.close('vault', vaultId);
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(`${rollback}${suffix}`)) {
          rmSync(`${livePath}${suffix}`, { force: true });
          renameSync(`${rollback}${suffix}`, `${livePath}${suffix}`);
        }
      }
    }
    checks.push({ name: 'apply', ok: false, detail_ar: `تعذّرت الاستعادة وأُعيد الملف السابق كما كان: ${(e as Error).message.slice(0, 160)}` });
    return out(false, checks, null, 0);
  } finally {
    if (ctx.system.vaults.byIdInternal(vaultId)?.status === 'locked') ctx.system.vaults.setStatusInternal(vaultId, 'active');
    rmSync(tmp, { force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}

