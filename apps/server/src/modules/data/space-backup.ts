// Per-space backups and their restore check (AOS-21.1 / X8 (d); ARCHITECTURE_DELTA §5.8). Platform-admin operations:
// the admin starts them, but no route ever shows the admin a space's content — only file names, sizes and the
// verification checks. (The whole-instance archive already carries every space, GATE-1; this is the backup of ONE
// subject as its own artifact, beside the per-vault one of ./vault-backup.ts.)
//
// A per-space backup is the archive of ONE subject space (spaces/<id>.sqlite: official lectures and their versions,
// attachments, course-only explanations) and the files its rows reference (layout 'space'), encrypted with «MLVENC01»
// when MEDLEVO_BACKUP_ENCRYPTION_KEY is set (the plain archive never stays on disk), kept in
// DATA_DIR/backups/spaces/<space id>/.
// The restore check verifies one of them in a separate directory (decrypt, hashes, integrity, base + space migrations
// of this build, row counts, files, boot on a sandbox holding that one space) and checks that it is THIS space's
// archive. It never changes the live space. (Putting a space back in place is not built: a space is shared by every
// student of the subject and holds the versions their copies point at — an in-place restore needs the fan-out design
// of an official version change, which Phase 1 does not have. The check proves the artifact restores.)
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SpaceBackupCheckView, SpaceBackupView } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { encryptArchive, ENC_SUFFIX } from './archive-crypto';
import { createBackup } from './backup';
import { verifyBackup } from './restore';

export const SPACE_BACKUP_NAME_RE = /^medlevo-space-[0-9TZ-]+-[0-9a-z]{8}\.tar\.gz(\.mlenc)?$/;

export const SPACE_BACKUP_NOTE_AR =
  'نسخة مساحة مادة واحدة (محاضراتها الرسمية وإصداراتها ومرفقاتها وشروحها) وملفاتها، تُحفظ على قرص الخادم مشفّرة (MLVENC01) متى ضُبط مفتاح التشفير. فحص الاستعادة يتحقق منها في مجلد منفصل ويشغّل الخادم على نسخة تجريبية منها، ولا يغيّر المساحة الحية.';

export function spaceBackupsDir(ctx: AppContext, spaceId: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(spaceId)) throw new AppError('NOT_FOUND', 'مساحة المادة غير موجودة.', 404);
  return join(ctx.config.dataDir, 'backups', 'spaces', spaceId);
}

function liveSpace(ctx: AppContext, spaceId: string) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(spaceId)) throw new AppError('NOT_FOUND', 'مساحة المادة غير موجودة.', 404);
  const s = ctx.system.vaults.spaceByIdInternal(spaceId);
  if (!s) throw new AppError('NOT_FOUND', 'مساحة المادة غير موجودة.', 404);
  return s;
}

function viewOf(dir: string, name: string): SpaceBackupView | null {
  if (!SPACE_BACKUP_NAME_RE.test(name)) return null;
  const p = join(dir, name);
  try {
    const st = statSync(p);
    const side = existsSync(`${p}.sha256`) ? readFileSync(`${p}.sha256`, 'utf8').split(/\s+/)[0] ?? '' : '';
    return { file_name: name, size: st.size, sha256: side, encrypted: name.endsWith(ENC_SUFFIX), created_at: Math.floor(st.mtimeMs) };
  } catch {
    return null;
  }
}

/** The space's registry title (what the backup records; never the space's content). */
export function spaceTitle(ctx: AppContext, spaceId: string): string {
  return liveSpace(ctx, spaceId).title;
}

export function listSpaceBackups(ctx: AppContext, spaceId: string): SpaceBackupView[] {
  liveSpace(ctx, spaceId);
  const dir = spaceBackupsDir(ctx, spaceId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((n) => viewOf(dir, n))
    .filter((v): v is SpaceBackupView => v !== null)
    .sort((a, b) => b.file_name.localeCompare(a.file_name));
}

/** Make a per-space backup (encrypted when the key is configured). */
export async function backupSpace(ctx: AppContext, spaceId: string): Promise<SpaceBackupView> {
  const s = liveSpace(ctx, spaceId);
  const dir = spaceBackupsDir(ctx, spaceId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const work = join(ctx.config.tmpDir, `space-backup-${newId(ctx.clock.now())}`);
  mkdirSync(work, { recursive: true, mode: 0o700 });
  try {
    const res = await createBackup({
      dataDir: ctx.config.dataDir,
      dbPath: ctx.config.dbPath,
      filesDir: ctx.config.filesDir,
      outDir: work,
      appVersion: ctx.config.appVersion,
      now: () => ctx.clock.now(),
      namePrefix: 'medlevo-space',
      // a file whose local copy is missing (MEDLEVO_BLOB_STORE=r2, evicted) is fetched back from the object store first
      ensureLocal: (sha, size) => ctx.blobs.ensureLocal(sha, size),
      spaceOnly: {
        // snapshotted read-consistently by path (VACUUM INTO), never through the pool
        space: { id: s.id, dbFile: s.db_file, path: ctx.pool.pathOfFile('space', s.db_file) },
        subject: { space_id: s.id, title: s.title },
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

/** The last restore check of each space in this process (the route runs it in the background). */
export const lastSpaceCheck = new Map<string, SpaceBackupCheckView>();

/** Verify ONE of this space's own backups (see the header). Never changes the live space. */
export async function verifySpaceBackup(ctx: AppContext, spaceId: string, fileName: string): Promise<SpaceBackupCheckView> {
  const s = liveSpace(ctx, spaceId);
  if (!SPACE_BACKUP_NAME_RE.test(fileName)) throw new AppError('NOT_FOUND', 'النسخة غير موجودة.', 404);
  const archive = join(spaceBackupsDir(ctx, spaceId), fileName);
  if (!existsSync(archive)) throw new AppError('NOT_FOUND', 'النسخة غير موجودة.', 404);
  const started = ctx.clock.now();
  mkdirSync(ctx.config.tmpDir, { recursive: true, mode: 0o700 });
  const res = await verifyBackup(archive, { workDir: ctx.config.tmpDir, decryptionKey: ctx.config.secrets.backupEncryptionKey(), now: () => ctx.clock.now() });
  const checks = res.report.checks.map((c) => ({ name: c.name, ok: c.ok, detail_ar: c.detail_ar }));
  const m = res.manifest;
  if (m) {
    const sp = m.spaces?.[0];
    const mine = m.layout === 'space' && sp?.space_id === s.id && sp.db_file === s.db_file;
    checks.push(
      mine
        ? { name: 'space', ok: true, detail_ar: `النسخة لمساحة هذه المادة (${s.title}).` }
        : { name: 'space', ok: false, detail_ar: 'هذه النسخة ليست لمساحة هذه المادة.' },
    );
  }
  return { space_id: spaceId, file_name: fileName, running: false, ok: checks.length > 0 && checks.every((c) => c.ok), checks, started_at: started, finished_at: ctx.clock.now() };
}
