// Restore from an off-site copy (PL-0): list what R2 holds, download one object (resumable), decrypt and
// authenticate it, then run the SAME verification as `npm run restore:verify` and restore into a NEW, empty directory
// beside the live data (never over it). Used by `medlevo-restore-offsite` (cli/restore-offsite.ts) from the Render
// dashboard's Shell. Switching the server to the restored directory is one environment change (MEDLEVO_DATA_DIR) and
// Render's automatic redeploy — the running server never has its data directory swapped underneath it.
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { RestoreReport } from '@medlevo/shared';
import type { AppConfig } from '../../config';
import { DecryptStream } from '../../lib/objectstore/encryption';
import type { S3ClientOptions } from '../../lib/objectstore/s3';
import { createOffsiteClient } from './offsite';
import { parseObjectName } from './offsite-schedule';
import { applyRestore, verifyBackup, type VerifyOptions } from './restore';

export class OffsiteRestoreError extends Error {
  constructor(readonly reasonAr: string) {
    super(reasonAr);
    this.name = 'OffsiteRestoreError';
  }
}

export interface RemoteObject {
  key: string;
  fileName: string;
  size: number;
  createdAt: number;
}

export async function listOffsite(config: AppConfig, clientOptions: S3ClientOptions = {}): Promise<RemoteObject[]> {
  if (!config.offsite.configured) throw new OffsiteRestoreError(`النسخ خارج الخادم غير مُعدّ على هذا الخادم: ${config.offsite.problems_ar.join(' ')}`);
  const objects = await createOffsiteClient(config, clientOptions).listObjects(`${config.offsite.prefix}backups/`);
  return objects
    .map((o) => ({ o, p: parseObjectName(o.key) }))
    .filter((x) => x.p !== null)
    .map(({ o, p }) => ({ key: o.key, fileName: p!.fileName, size: o.size, createdAt: p!.createdAt }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export interface OffsiteRestoreOptions {
  /** an object key, or the archive file name (medlevo-backup-….tar.gz[.mlenc]); default: the newest */
  key?: string | null;
  /** restore into this empty directory (default: medlevo-restored-<time> beside the live data directory) */
  target?: string | null;
  /** only download, decrypt and verify (nothing is restored) */
  verifyOnly?: boolean;
  /** see restore:verify --accept-missing-files */
  acceptMissingFiles?: boolean;
  /** allow a target on another filesystem than the live data (on Render only the disk survives a redeploy) */
  allowOtherDisk?: boolean;
  bootCheck?: boolean;
  clientOptions?: S3ClientOptions;
  now?: () => number;
  log?: (line: string) => void;
}

export interface OffsiteRestoreResult {
  object: RemoteObject;
  report: RestoreReport;
  /** the restored data directory (null for verify-only or a failed check) */
  restoredTo: string | null;
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
}

export async function restoreFromOffsite(config: AppConfig, o: OffsiteRestoreOptions = {}): Promise<OffsiteRestoreResult> {
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => undefined);
  const master = config.secrets.backupEncryptionKey();
  if (!config.offsite.configured || !master) throw new OffsiteRestoreError(`النسخ خارج الخادم غير مُعدّ على هذا الخادم: ${config.offsite.problems_ar.join(' ')}`);

  const objects = await listOffsite(config, o.clientOptions);
  if (objects.length === 0) throw new OffsiteRestoreError('لا توجد أي نسخة احتياطية في R2 تحت هذا المسار بعد.');
  let object: RemoteObject | undefined;
  if (o.key) {
    const want = o.key.trim().replace(/\.mlenc$/, '');
    object = objects.find((x) => x.key === o.key || x.fileName === want || x.key.endsWith(`/${want}.mlenc`));
    if (!object) throw new OffsiteRestoreError(`لا توجد في R2 نسخة باسم ${o.key}. شغّل الأمر مع --list لرؤية الأسماء.`);
  } else {
    object = objects[0]!;
  }

  const live = resolve(config.dataDir);
  const parent = dirname(live);
  const target = o.verifyOnly ? null : resolve(o.target ?? join(parent, `medlevo-restored-${stamp(now())}`));
  if (target && !o.allowOtherDisk) {
    // a restore must land on the same persistent disk as the live data (Render: everything else is wiped by a deploy)
    const probe = existsSync(dirname(target)) ? dirname(target) : parent;
    if (existsSync(live) && statSync(probe).dev !== statSync(live).dev) {
      throw new OffsiteRestoreError(`المجلد ${target} ليس على القرص نفسه الذي عليه البيانات (${live}). على Render يُمحى كل ما خارج القرص الدائم عند النشر. اختر مجلدًا على القرص، أو أضف --allow-other-disk إن كنت متأكدًا.`);
    }
  }

  // working files on the same disk (the download can be large; /tmp may be small or ephemeral)
  const work = join(parent, `.medlevo-offsite-restore-${stamp(now())}`);
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const enc = join(work, `${basename(object.fileName)}.mlenc`);
  const archive = join(work, object.fileName);
  try {
    log(`Downloading ${object.key} (${object.size} bytes)…`);
    await createOffsiteClient(config, o.clientOptions).getObjectToFile(object.key, enc, { expectedSize: object.size });
    log('Decrypting and authenticating…');
    await pipeline(createReadStream(enc), new DecryptStream(master), createWriteStream(archive, { mode: 0o600 }));
    rmSync(enc, { force: true });
    const vopts: VerifyOptions = { now, acceptMissingFiles: o.acceptMissingFiles ?? false, bootCheck: o.bootCheck ?? true };
    if (!target) {
      log('Verifying (restore:verify checks in a temporary directory)…');
      const res = await verifyBackup(archive, { ...vopts, workDir: work });
      return { object, report: res.report, restoredTo: null };
    }
    log(`Verifying and restoring into ${target}…`);
    const res = await applyRestore(archive, target, { ...vopts, liveDataDir: live });
    return { object, report: res.report, restoredTo: res.report.ok ? (res.report.restored_to ?? target) : null };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
