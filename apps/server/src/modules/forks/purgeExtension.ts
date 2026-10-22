// The forks module's purge step (P1-T5 step 2; ARCHITECTURE_DELTA §6.3 invariant 4 «purge of an official version is
// refused while lecture_copy shows personal items on it (a count, never names); otherwise it deletes only space rows»;
// BUILD_PLAN §3.7: the Wave 2 owner of the purge refuses through `lecture_copy`). Registered through P1-T1's
// purge-extension seam (sources/purge.ts), so the core purge is not edited:
//   * in a SPACE: before anything is deleted, the holders of the purged official versions are counted again IN THEIR
//     VAULTS (the index may be minutes old) and the purge is refused while anyone has personal items on them — the
//     refusal says how many people (suppressed under 5), never who. Vaults are only read.
//   * in a VAULT: purging a stub (the user's own choice, from the trash) removes the copy rows that reference it and
//     the pins of its regions; the system index forgets that this user holds the lecture.
import { groupCount } from '@medlevo/shared';
import type { AppContext } from '../../context';
import type { Db } from '../../db/db';
import { AppError } from '../../lib/errors';
import { registerPurgeExtension, type PurgeSetView } from '../sources/purge';
import { vaultUser } from './copies';
import { forksSystem, publicationIndex } from './system';

/** Personal items (live annotations + notes) on these versions in one vault's database. */
export function personalItemsIn(db: Db, versionIds: readonly string[]): number {
  if (versionIds.length === 0) return 0;
  const inV = versionIds.map(() => '?').join(',');
  const a = db.get<{ n: number }>(
    `SELECT COUNT(DISTINCT t.annotation_id) AS n FROM annotation_target t JOIN source_page p ON p.id = t.target_id JOIN annotation a ON a.id = t.annotation_id
      WHERE t.target_type = 'source_page' AND a.deleted_at IS NULL AND a.author_user_id IS NULL AND p.version_id IN (${inV})`,
    [...versionIds],
  );
  const n = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM note n JOIN source_page p ON n.anchor_target_key = 'source_page:' || p.id WHERE n.deleted_at IS NULL AND n.author_user_id IS NULL AND p.version_id IN (${inV})`,
    [...versionIds],
  );
  return (a?.n ?? 0) + (n?.n ?? 0);
}

function boundKind(ctx: AppContext): { kind: 'space'; spaceId: string } | { kind: 'vault' } | null {
  const b = ctx.binding.current() ?? ctx.binding.harnessDefault();
  if (!b || b.kind === 'root') return null;
  return b.kind === 'space' ? { kind: 'space', spaceId: b.spaceId } : { kind: 'vault' };
}

/** Holders with personal items on the purged official versions, counted live in their vaults (read only). */
function holdersWithItems(ctx: AppContext, spaceId: string, set: PurgeSetView): { users: number; items: number } {
  const versionIds = ctx.db.all<{ id: string }>(`SELECT id FROM ${set.table('version')}`).map((r) => r.id);
  if (versionIds.length === 0) return { users: 0, items: 0 };
  const sys = forksSystem(ctx);
  let users = 0;
  let items = 0;
  for (const userId of sys.holdersOfVersions(spaceId, versionIds)) {
    // any vault that still exists counts — also one locked for a restore or of a suspended account (review R-D)
    const vault = sys.vaultStateOf(userId);
    if (!vault) continue;
    let n = 0;
    try {
      // a vault that cannot be read right now counts as holding items: never purge under it
      n = vault.readable ? personalItemsIn(ctx.dbs.vault(vault.id), versionIds) : 1;
    } catch {
      n = 1;
    }
    if (n > 0) {
      users++;
      items += n;
    }
  }
  return { users, items };
}

export function registerForksPurgeExtension(ctx: AppContext): () => void {
  return registerPurgeExtension(ctx, {
    name: 'forks',
    handledForeignKeys: [
      'document_copy.source_id',
      'document_copy.personal_layer_id',
      'document_copy.copied_layer_id',
      // a space's official rows that point at the purged source / versions (deleted in apply when the purge may go on)
      'official_lecture.source_id',
      'official_lecture.head_version_id',
      'official_version_publish.version_id',
      'official_version_publish.previous_version_id',
      'official_version_upload.version_id',
      'official_correction.version_id',
      'official_correction.result_version_id',
      'subject_attachment.source_id',
      // P1-T5 step 3: a publication's content on the purged lecture (its readers' copies stay in their vaults)
      'publication_version.lecture_id',
      'publication_version.lecture_version_id',
    ],
    count(c, set): Record<string, number> {
      const k = boundKind(c);
      if (k?.kind === 'space') {
        const r = holdersWithItems(c, k.spaceId, set);
        return { holders_with_items: r.users };
      }
      const copies = c.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM document_copy WHERE source_id IN ${set.in('source')}`)?.n ?? 0;
      return { study_copies: copies };
    },
    linesAr(counts, mode) {
      if (mode !== 'purge') return [];
      const lines: string[] = [];
      const holders = counts.holders_with_items ?? 0;
      if (holders > 0) lines.push(`طلاب لديهم ملاحظات على هذه المحاضرة: ${groupCount(holders).label_ar} — لا يُحذف نهائيًا ما دامت ملاحظاتهم عليها.`);
      const copies = counts.study_copies ?? 0;
      if (copies > 0) lines.push(`نسخ دراسة لهذه المحاضرة في مكتبتك: ${copies} — تُحذف معها.`);
      return lines;
    },
    apply(c, set) {
      const k = boundKind(c);
      if (k?.kind === 'space') {
        const r = holdersWithItems(c, k.spaceId, set);
        if (r.users > 0) {
          const g = groupCount(r.users);
          throw new AppError(
            'CONFLICT',
            `لا يمكن حذف هذه المحاضرة نهائيًا: لدى ${g.label_ar} من الطلاب ملاحظات عليها في نسخهم. اسحبها بدلًا من ذلك؛ يبقى كل ما كتبوه.`,
            409,
            { holders: g },
          );
        }
        // nobody's notes depend on it: only SPACE rows go (vault stubs stay in their vaults, untouched)
        const lectures = c.db.all<{ id: string }>(`SELECT id FROM official_lecture WHERE source_id IN ${set.in('source')}`).map((x) => x.id);
        const inL = lectures.map(() => '?').join(',');
        c.db.run(`DELETE FROM official_correction WHERE version_id IN ${set.in('version')} OR result_version_id IN ${set.in('version')}${lectures.length ? ` OR lecture_id IN (${inL})` : ''}`, lectures);
        c.db.run(`DELETE FROM official_version_upload WHERE version_id IN ${set.in('version')}${lectures.length ? ` OR lecture_id IN (${inL})` : ''}`, lectures);
        c.db.run(`UPDATE official_version_publish SET previous_version_id = NULL WHERE previous_version_id IN ${set.in('version')}`);
        c.db.run(`DELETE FROM official_version_publish WHERE version_id IN ${set.in('version')}${lectures.length ? ` OR lecture_id IN (${inL})` : ''}`, lectures);
        // publications on the purged lectures (or written on a purged version): their space rows go and the index
        // withdraws them — every fork and followed copy keeps what it had in its own vault
        const pubIds = c.db
          .all<{ publication_id: string }>(
            `SELECT DISTINCT publication_id FROM publication_version WHERE lecture_version_id IN ${set.in('version')}${lectures.length ? ` OR lecture_id IN (${inL})` : ''}`,
            lectures,
          )
          .map((r) => r.publication_id);
        for (const pid of pubIds) {
          c.db.run('DELETE FROM publication_item WHERE publication_id = ?', [pid]);
          c.db.run('DELETE FROM publication_version WHERE publication_id = ?', [pid]);
          publicationIndex(c).withdraw(pid);
        }
        if (lectures.length) c.db.run(`UPDATE subject_attachment SET lecture_id = NULL WHERE lecture_id IN (${inL})`, lectures);
        c.db.run(`DELETE FROM subject_attachment WHERE source_id IN ${set.in('source')}`);
        if (lectures.length) c.db.run(`DELETE FROM official_lecture WHERE id IN (${inL})`, lectures);
        for (const l of lectures) for (const u of forksSystem(c).holdersPage(k.spaceId, l, null, 100_000)) forksSystem(c).dropHoldings(u, k.spaceId, l);
        return;
      }
      // a vault: the user's own copies of the purged stubs go with them (their items are purged by the core and P1-T2)
      const stubs = c.db.all<{ id: string; origin_space_id: string | null; origin_lecture_id: string | null }>(
        `SELECT id, origin_space_id, origin_lecture_id FROM source WHERE id IN ${set.in('source')} AND is_stub = 1`,
      );
      c.db.run(`DELETE FROM document_copy WHERE source_id IN ${set.in('source')}`);
      c.db.run(`DELETE FROM pinned_region WHERE version_id IN ${set.in('version')}`);
      const userId = vaultUser(c);
      if (userId) for (const s of stubs) if (s.origin_space_id && s.origin_lecture_id) forksSystem(c).dropHoldings(userId, s.origin_space_id, s.origin_lecture_id);
      return undefined;
    },
  });
}
