// Case / OSCE signals for the Weakness Center (§44). The learning module collects MCQ, card and written signals and
// does NOT expose an input for other modules yet (docs/modules/learning.md: «Case / OSCE attempts: not collected»),
// so this module publishes its signals in the shared WeaknessSignal shape (+ grouping hints) at
// GET /api/cases/signals for the learning track to consume. Only COMPLETED attempts count; each checklist item /
// viva point is one signal (met → correct). Items judged by the owner say so. Nothing here is a mastery score.
import type { CaseSignalsResponse, CaseWeaknessSignal } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { getViews } from '../evidence/services';
import { judgeChecklist, judgeViva, replay } from './engine';
import { definitionOf, eventsOf, getVersionById, type AttemptRow } from './store';
import { fromJson } from '../../db/db';

export function caseSignals(ctx: AppContext, opts: { since?: number } = {}): CaseSignalsResponse {
  const attempts = ctx.db.all<AttemptRow>(
    `SELECT a.* FROM case_attempt a JOIN clinical_case c ON c.id = a.case_id
      WHERE a.status = 'completed' AND c.deleted_at IS NULL AND a.case_version_id IS NOT NULL AND COALESCE(a.finished_at, 0) >= ?
      ORDER BY a.finished_at, a.id`,
    [opts.since ?? 0],
  );
  const signals: CaseWeaknessSignal[] = [];
  const sourceCache = new Map<string, string[]>();
  const sourcesOf = (ids: string[]): string[] => {
    const key = ids.join(',');
    if (!sourceCache.has(key)) sourceCache.set(key, [...new Set(getViews(ctx, ids).map((v) => v.source_id))]);
    return sourceCache.get(key)!;
  };
  for (const a of attempts) {
    const def = definitionOf(getVersionById(ctx, a.case_version_id!));
    const events = eventsOf(ctx, a.id).map((e) => ({ id: e.id, seq: e.seq, type: e.type as never, payload: fromJson<Record<string, unknown>>(e.payload_json, {}) ?? {}, at: e.created_at }));
    let state;
    try {
      state = replay(def, events);
    } catch {
      continue; // a log that no longer replays is reported by the attempt itself, never guessed here
    }
    const type: CaseWeaknessSignal['type'] = def.kind === 'osce' ? 'osce' : 'case';
    const at = a.finished_at ?? a.updated_at;
    for (const j of judgeChecklist(def, state)) {
      signals.push({
        type,
        ref_id: `${a.id}:${j.item.id}`,
        at,
        correct: j.met,
        confidence: null,
        hints_used: 0,
        mistake_type: null,
        mistake_origin: null,
        label: `${def.title} — ${j.item.text}`,
        case_id: a.case_id,
        item_id: j.item.id,
        source_ids: sourcesOf(j.item.rationale.flatMap((s) => s.evidence_ids)),
        owner_judged: j.override !== null,
      });
    }
    for (const q of judgeViva(def, state)) {
      for (const p of q.question.points) {
        const covered = q.covered.find((c) => c.id === p.id);
        signals.push({
          type: 'case',
          ref_id: `${a.id}:${q.question.id}:${p.id}`,
          at,
          correct: !!covered,
          confidence: null,
          hints_used: 0,
          mistake_type: null,
          mistake_origin: null,
          label: `${def.title} — ${p.text}`,
          case_id: a.case_id,
          item_id: `${q.question.id}:${p.id}`,
          source_ids: sourcesOf(p.rationale.flatMap((s) => s.evidence_ids)),
          owner_judged: covered?.by === 'owner' || (!covered && !!state.overrides[`${q.question.id}:${p.id}`]),
        });
      }
    }
  }
  return {
    signals,
    note_ar: 'إشارات من محاولات الحالات ومحطات OSCE والامتحان الشفهي المكتملة (بند تحقق / لم يتحقق). تقدير من قوائم التقييم فقط؛ لم يُربط بعد بمركز نقاط الضعف لأن وحدة التعلّم لا تستقبل إشارات من وحدات أخرى في هذا الإصدار.',
  };
}
