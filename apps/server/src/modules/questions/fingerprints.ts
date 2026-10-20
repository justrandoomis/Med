// Re-fingerprinting (H2 item 10f, migration 0530): exact-duplicate fingerprints written before the G5 / AC-17 fix
// ignored meaning-bearing symbols, so a new «base excess 8» question matched the stored fingerprint of «base excess −8»
// and was attached to it as the same question (a false «conflicting key» followed). Every version still carrying a
// pre-fix fingerprint (fingerprint_algo < 2) is recomputed from its stored stem and options with the current algorithm.
// Idempotent and resumable: batches in transactions, each row marked algo 2 when rewritten.
import { richTextToPlain, type RichText } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import { optionRows } from './store';
import { fingerprint } from './text';

export const FINGERPRINT_ALGO = 2;

export function refingerprintVersions(ctx: AppContext, batch = 500): number {
  let total = 0;
  for (;;) {
    const rows = ctx.db.all<{ id: string; stem_json: string; fingerprint: string | null }>(
      'SELECT id, stem_json, fingerprint FROM question_version WHERE fingerprint_algo < ? ORDER BY id LIMIT ?',
      [FINGERPRINT_ALGO, batch],
    );
    if (rows.length === 0) return total;
    ctx.db.tx(() => {
      for (const r of rows) {
        const stem = richTextToPlain(fromJson<RichText | null>(r.stem_json, null));
        const options = optionRows(ctx, r.id).map((o) => richTextToPlain(fromJson<RichText | null>(o.text_json, null)));
        // a version without a fingerprint (a derived translation / paraphrase) keeps none
        const fp = r.fingerprint === null ? null : fingerprint(stem, options);
        ctx.db.run('UPDATE question_version SET fingerprint = ?, fingerprint_algo = ? WHERE id = ?', [fp, FINGERPRINT_ALGO, r.id]);
      }
    });
    total += rows.length;
  }
}
