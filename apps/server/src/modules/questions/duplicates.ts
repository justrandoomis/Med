// Near duplicates & paraphrases (§36, AC-17). Exact duplicates are merged at extraction time (one question,
// several occurrences). Similar questions are only SUGGESTED, with the reasons they must not be merged
// (negation differs, numbers/units differ, options differ, keys differ). Nothing is merged automatically, and the
// owner's confirm/reject decision is never overridden by a later run.
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { syncReviewItems } from './review';
import { correctOptionKeys, currentVersion, getQuestionRow, optionRows, stemText, type QuestionRow, type VersionRow } from './store';
import { allTokens, contentTokens, jaccard, negationKey, negationTerms, normPhrase, numberUnitTokens, refersToImage } from './text';
import { richTextToPlain, stemPreview, type RichText } from '@medlevo/shared';

interface Shape {
  q: QuestionRow;
  v: VersionRow;
  stem: string;
  options: Map<string, string>; // option_key → text
  correctTexts: string[] | null;
}

function shapeOf(ctx: AppContext, id: string): Shape | null {
  const q = ctx.db.get<QuestionRow>('SELECT * FROM question WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!q || !q.current_version_id || q.status === 'retired') return null;
  const v = currentVersion(ctx, q);
  const options = new Map(optionRows(ctx, v.id).map((o) => [o.option_key, richTextToPlain(fromJson<RichText | null>(o.text_json, null))]));
  const keys = correctOptionKeys(ctx, v);
  return { q, v, stem: stemText(v), options, correctTexts: keys && keys.length ? keys.map((k) => options.get(k) ?? '').map(normPhrase) : null };
}

export interface PairAssessment {
  kind: 'near' | 'paraphrase' | null;
  similarity: number;
  blockers: string[];
}

export function assessPair(a: Pick<Shape, 'stem' | 'options' | 'correctTexts' | 'v'>, b: Pick<Shape, 'stem' | 'options' | 'correctTexts' | 'v'>): PairAssessment {
  const stemSim = jaccard(allTokens(a.stem), allTokens(b.stem));
  const optsA = [...a.options.values()].map(normPhrase);
  const optsB = [...b.options.values()].map(normPhrase);
  const hasOptions = optsA.length > 0 && optsB.length > 0;
  const optSim = hasOptions ? jaccard(optsA, optsB) : stemSim;
  const similarity = hasOptions ? 0.6 * stemSim + 0.4 * optSim : stemSim;
  let kind: PairAssessment['kind'] = null;
  if (stemSim >= 0.7 && similarity >= 0.6) kind = 'near';
  else if (hasOptions && optSim >= 0.75 && stemSim >= 0.35) kind = 'paraphrase';
  const blockers: string[] = [];
  if (kind) {
    const nA = negationKey(negationTerms(a.stem)).join(',');
    const nB = negationKey(negationTerms(b.stem)).join(',');
    if (nA !== nB) blockers.push(`صيغة النفي مختلفة (${negationTerms(a.stem).join('، ') || 'بلا نفي'} ↔ ${negationTerms(b.stem).join('، ') || 'بلا نفي'})`);
    const numsA = [a.stem, ...a.options.values()].flatMap(numberUnitTokens).sort().join('|');
    const numsB = [b.stem, ...b.options.values()].flatMap(numberUnitTokens).sort().join('|');
    if (numsA !== numsB) blockers.push('الأرقام أو الوحدات مختلفة');
    if (hasOptions && optSim < 1) blockers.push(`الخيارات مختلفة (${optsA.filter((o) => !optsB.includes(o)).length} خيار غير مشترك)`);
    if (a.correctTexts && b.correctTexts && a.correctTexts.slice().sort().join('|') !== b.correctTexts.slice().sort().join('|')) blockers.push('الإجابة الصحيحة مختلفة');
    if (a.v.qtype !== b.v.qtype) blockers.push('نوع السؤال مختلف');
    if (refersToImage(a.stem) || refersToImage(b.stem)) blockers.push('السؤال يعتمد على صورة أو شكل — قارن الصورتين في الأصل قبل اعتبارهما سؤالًا واحدًا');
  }
  return { kind, similarity: Math.round(similarity * 1000) / 1000, blockers };
}

/** Suggest near duplicates / paraphrases of one question among the vault (FTS pre-filter, then pairwise checks). */
export function detectNearDuplicates(ctx: AppContext, questionId: string): number {
  const me = shapeOf(ctx, questionId);
  if (!me || me.q.origin_type === 'generated') return 0;
  const terms = contentTokens(me.stem)
    .filter((t) => !t.generic)
    .slice(0, 12)
    .map((t) => `"${t.norm.replace(/"/g, '""')}"`);
  if (terms.length === 0) return 0;
  const candidates = ctx.db.all<{ question_id: string }>(
    `SELECT question_id FROM question_fts WHERE question_fts MATCH ? AND question_id <> ? ORDER BY rank LIMIT 30`,
    [terms.join(' OR '), questionId],
  );
  let n = 0;
  for (const c of candidates) {
    const other = shapeOf(ctx, c.question_id);
    if (!other || other.q.origin_type === 'generated') continue;
    const res = assessPair(me, other);
    if (!res.kind) continue;
    const [a, b] = questionId < other.q.id ? [questionId, other.q.id] : [other.q.id, questionId];
    const prior = ctx.db.get<{ id: string; status: string }>('SELECT id, status FROM question_duplicate WHERE question_a_id = ? AND question_b_id = ?', [a, b]);
    const now = ctx.clock.now();
    let dupId: string;
    if (prior) {
      dupId = prior.id;
      if (prior.status !== 'suggested') continue; // the owner decided — never overridden
      ctx.db.run('UPDATE question_duplicate SET kind = ?, similarity = ?, blockers_json = ? WHERE id = ?', [res.kind, res.similarity, toJson(res.blockers), dupId]);
    } else {
      dupId = newId(now);
      ctx.db.run(
        `INSERT INTO question_duplicate (id, question_a_id, question_b_id, kind, similarity, blockers_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'suggested', ?)`,
        [dupId, a, b, res.kind, res.similarity, toJson(res.blockers), now],
      );
    }
    const otherPreview = stemPreview(fromJson<RichText | null>(other.v.stem_json, null), 90);
    syncReviewItems(
      ctx,
      'question_duplicate',
      dupId,
      'duplicate',
      [
        {
          kind: 'duplicate_suggestion',
          code: 'duplicate',
          reason:
            `سؤال ${res.kind === 'near' ? 'شبيه جدًا' : 'بصياغة أخرى قريبة'} من «${otherPreview}». ` +
            (res.blockers.length
              ? `لا يُدمج تلقائيًا: ${res.blockers.join('، ')}.`
              : 'لم تُكتشف فروق مانعة، لكنه لا يُدمج دون تأكيدك.'),
          details: { question_ids: [a, b], kind: res.kind, blockers: res.blockers },
        },
      ],
      null,
      questionId,
    );
    n++;
  }
  return n;
}

export function decideDuplicate(ctx: AppContext, dupId: string, status: 'confirmed' | 'rejected', reason: string | null): void {
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    const d = ctx.db.get<{ id: string; question_a_id: string; question_b_id: string; status: string }>('SELECT * FROM question_duplicate WHERE id = ?', [dupId]);
    if (!d) throw new AppError('NOT_FOUND', 'اقتراح التكرار غير موجود.', 404);
    getQuestionRow(ctx, d.question_a_id);
    ctx.db.run('UPDATE question_duplicate SET status = ?, decision_reason = ?, decided_at = ? WHERE id = ?', [status, reason, now, dupId]);
    ctx.db.run(
      `UPDATE review_queue_item SET status = ?, resolved_at = ?, resolution_json = ? WHERE entity_type = 'question_duplicate' AND entity_id = ? AND status = 'open'`,
      [status === 'confirmed' ? 'accepted' : 'rejected', now, toJson({ by: 'owner', note: reason }), dupId],
    );
    ctx.audit.record({
      entityType: 'question_duplicate',
      entityId: dupId,
      action: status === 'confirmed' ? 'confirm_duplicate' : 'reject_duplicate',
      summary: status === 'confirmed' ? 'أكدت أن السؤالين مكرران (لا يظهران معًا في اختبار واحد؛ لم يُدمج محتواهما)' : 'رفضت اقتراح التكرار',
      before: { status: d.status },
      after: { status, reason },
    });
  });
}
