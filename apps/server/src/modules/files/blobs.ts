// Blob lifecycle (ADR-0003 §3.3, ARCHITECTURE_DELTA §4.1 `2250_ops`). Every module that drops a stored file goes
// through here instead of deleting bytes itself (the sources purge, upload clean-up, annotation image pruning).
//
// Step 0 of P1-T1 moved today's behaviour here unchanged: a stored_file row — and its bytes — are removed when NO row of
// THIS database references it any more (checked through every foreign key into stored_file, so tables added later by
// other modules are covered). With one owner and one database that is exact.
//
// Step 2 (multi-user) replaces the body with «delete my stored_file row and decrement my blob_ref hint»: bytes are then
// deleted only by the mark-and-sweep GC over every vault and space, because a blob can be shared by several databases
// and per-file restores make reference counts drift. Callers do not change.
import { rmSync } from 'node:fs';
import type { AppContext } from '../../context';

/** Child columns of every foreign key into stored_file (asked from the schema, never hard-coded). */
function storedFileReferences(ctx: AppContext): Array<{ tbl: string; col: string }> {
  return ctx.db.all<{ tbl: string; col: string }>(
    `SELECT m.name AS tbl, p."from" AS col
     FROM sqlite_master m, pragma_foreign_key_list(m.name) p
     WHERE m.type = 'table' AND p."table" = 'stored_file'`,
  );
}

/**
 * Delete a stored_file row + its blob when NO table references it any more. Runs outside the caller's transaction
 * (after its commit). Returns true when the row was removed; false when it is still referenced or already gone.
 */
export function removeStoredFileIfUnreferenced(ctx: AppContext, fileId: string): boolean {
  const refs = storedFileReferences(ctx);
  let path: string | null = null;
  const removed = ctx.db.tx(() => {
    for (const fk of refs) {
      if (ctx.db.get(`SELECT 1 AS x FROM "${fk.tbl}" WHERE "${fk.col}" = ? LIMIT 1`, [fileId])) return false;
    }
    const file = ctx.files.stat(fileId);
    if (!file) return false;
    path = ctx.files.path(fileId);
    ctx.db.run('DELETE FROM stored_file WHERE id = ?', [fileId]);
    return true;
  });
  if (removed && path) {
    try {
      rmSync(path, { force: true });
    } catch (e) {
      ctx.log.warn({ err: e, fileId }, 'could not remove purged blob');
    }
  }
  return removed;
}
