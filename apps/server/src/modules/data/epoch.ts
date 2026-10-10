// Server data epoch (table data_server_epoch, migration 0750). A restore replaces the server's data with an
// older snapshot, so the sync change feed (sync_change.seq) goes back in time. Clients store the epoch id they
// last pulled from; GET /api/sync/pull returns the current one, and a different id tells the client to reset its
// pull cursor and re-send its own writes acknowledged after `base_seq` (see apps/web/src/lib/sync.ts).
import { randomBytes } from 'node:crypto';
import type { Db } from '../../db/db';

export interface ServerEpoch {
  id: string;
  started_at: number;
  base_seq: number;
  reason: 'initial' | 'restore';
  backup_id: string | null;
  backup_created_at: number | null;
}

export function syncHeadSeq(db: Db): number {
  const r = db.get<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'sync_change'");
  return r?.seq ?? 0;
}

/** The current epoch, or null when the table does not exist yet (database older than migration 0750). */
export function currentEpoch(db: Db): ServerEpoch | null {
  try {
    return (
      db.get<ServerEpoch>(
        'SELECT id, started_at, base_seq, reason, backup_id, backup_created_at FROM data_server_epoch WHERE is_current = 1',
      ) ?? null
    );
  } catch {
    return null;
  }
}

/** Makes sure exactly one current epoch exists (the migration inserts one; this repairs a missing row). */
export function ensureEpoch(db: Db, now: number): ServerEpoch {
  const cur = currentEpoch(db);
  if (cur) return cur;
  const id = randomBytes(16).toString('hex');
  db.run(
    `INSERT INTO data_server_epoch (id, started_at, base_seq, reason, is_current, created_at) VALUES (?, ?, ?, 'initial', 1, ?)`,
    [id, now, syncHeadSeq(db), now],
  );
  return currentEpoch(db)!;
}

/** Starts a new epoch (restore). The previous rows stay as history. */
export function startRestoreEpoch(db: Db, opts: { now: number; backupId: string | null; backupCreatedAt: number | null }): ServerEpoch {
  return db.tx(() => {
    db.run('UPDATE data_server_epoch SET is_current = 0 WHERE is_current = 1');
    const id = randomBytes(16).toString('hex');
    db.run(
      `INSERT INTO data_server_epoch (id, started_at, base_seq, reason, backup_id, backup_created_at, is_current, created_at)
       VALUES (?, ?, ?, 'restore', ?, ?, 1, ?)`,
      [id, opts.now, syncHeadSeq(db), opts.backupId, opts.backupCreatedAt, opts.now],
    );
    return currentEpoch(db)!;
  });
}
