// Sources & priorities (§09, §48): per-task source-type priority (where evidence search STARTS — never who wins a
// conflict) and each source's own priority number + selection reason (the owner's notes on why a source was
// chosen). Changes to the task priorities go through the impact preview; per-source fields through the sources API.
import {
  PRIORITY_PURPOSES,
  PRIORITY_PURPOSE_LABELS_AR,
  SOURCE_TYPES,
  SOURCE_TYPE_LABELS_AR,
  type ControlSourceRow,
  type ProcessingStatus,
  type SourceType,
  type SourcesPrioritiesResponse,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { oneLine } from './labels';

interface Row {
  id: string;
  title: string;
  source_type: SourceType;
  priority: number;
  selection_reason: string | null;
  processing_status: ProcessingStatus;
  frozen_version_id: string | null;
  active_no: number | null;
}

export function sourcesPriorities(ctx: AppContext): SourcesPrioritiesResponse {
  const s = ctx.settings.get();
  const rows = ctx.db.all<Row>(
    `SELECT s.id, s.title, s.source_type, s.priority, s.selection_reason, s.processing_status, s.frozen_version_id,
            (SELECT v.version_no FROM source_version v WHERE v.id = COALESCE(s.frozen_version_id, s.current_version_id)) AS active_no
       FROM source s WHERE s.deleted_at IS NULL AND s.archived_at IS NULL
      ORDER BY s.priority DESC, s.source_type, s.title COLLATE NOCASE LIMIT 500`,
  );
  const refs = new Map<string, string[]>();
  for (const l of ctx.db.all<{ from_source_id: string; title: string }>(
    `SELECT l.from_source_id, t.title FROM source_link l JOIN source t ON t.id = l.to_source_id WHERE l.relation = 'reference_for' AND t.deleted_at IS NULL`,
  )) {
    refs.set(l.from_source_id, [...(refs.get(l.from_source_id) ?? []), oneLine(l.title, 120) ?? '']);
  }
  const open = new Map(
    ctx.db.all<{ source_id: string; n: number }>(`SELECT source_id, COUNT(*) AS n FROM review_queue_item WHERE status = 'open' AND source_id IS NOT NULL GROUP BY source_id`).map((r) => [r.source_id, r.n]),
  );
  const sources: ControlSourceRow[] = rows.map((r) => ({
    id: r.id,
    title: oneLine(r.title, 200) ?? '',
    source_type: r.source_type,
    source_type_label_ar: SOURCE_TYPE_LABELS_AR[r.source_type] ?? r.source_type,
    priority: r.priority,
    selection_reason: r.selection_reason,
    processing_status: r.processing_status,
    active_version_no: r.active_no,
    frozen: r.frozen_version_id !== null,
    reference_for: (refs.get(r.id) ?? []).slice(0, 10),
    open_review_items: open.get(r.id) ?? 0,
  }));
  return {
    purposes: PRIORITY_PURPOSES.map((p) => ({
      purpose: p,
      title_ar: PRIORITY_PURPOSE_LABELS_AR[p].title,
      description_ar: PRIORITY_PURPOSE_LABELS_AR[p].description,
      order: [...((s.source_priority as Record<string, string[]>)[p] ?? [])],
    })),
    source_types: SOURCE_TYPES.filter((t) => t !== 'external_source').map((t) => ({ value: t, label_ar: SOURCE_TYPE_LABELS_AR[t] })),
    sources,
    notes_ar: [
      'الأولوية تحدد من أين يبدأ البحث عن الأدلة لكل مهمة، ولا تقرر من «يفوز» عند التعارض: كل مصدر وُجد فيه دليل يبقى ممثَّلًا، والتعارض يُعرض بطرفيه.',
      '«ملاحظاتي» تأتي دائمًا بعد المصادر الأكاديمية، ولا تدخل النطاق إلا إذا طلبتها.',
      'الرقم الخاص بكل مصدر وسبب اختياره ملاحظات تنظيمية لك؛ ترتيب البحث يتبع أولوية الأنواع لكل مهمة.',
      'تغيير أولوية المهام يُعرض أثره أولًا، ولا يعيد توليد أي محتوى.',
    ],
  };
}
