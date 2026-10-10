// Audit history viewer (§48, §56): the owner-visible change log in words — what changed, by whom (you / a job /
// the system), when, and the before → after facts. Secret-looking fields are redacted by the audit log itself.
import {
  LECTURE_KIND_LABELS_AR,
  LIBRARY_NODE_KIND_LABELS_AR,
  REVIEW_ITEM_STATUS_LABELS_AR,
  SOURCE_TYPE_LABELS_AR,
  type HistoryEntryView,
  type HistoryResponse,
  type ReviewLink,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { ACTION_LABELS_AR, ACTOR_LABELS_AR, ENTITY_LABELS_AR, PROCESSING_STATUS_LABELS_AR, REGION_STATUS_LABELS_AR, TEXT_ORIGIN_LABELS_AR, oneLine } from './labels';

const FIELD_LABELS_AR: Record<string, string> = {
  text: 'النص',
  text_origin: 'مصدر النص',
  status: 'الحالة',
  title: 'العنوان',
  source_type: 'نوع المصدر',
  node_id: 'المجلد',
  lecture_kind: 'نوع المحاضرة',
  lecture_kind_origin: 'مصدر التصنيف',
  priority: 'الأولوية',
  selection_reason: 'سبب الاختيار',
  note: 'ملاحظتك',
  key_label: 'المفتاح',
  confidence: 'الثقة',
  explanation_level: 'مستوى الشرح',
  dialect: 'أسلوب اللغة',
  custom_instruction: 'تعليماتك الخاصة',
  socratic_default: 'الأسلوب السقراطي',
  answer_style: 'أسلوب الإجابة',
  source_priority: 'أولوية المصادر',
  theme: 'السمة',
  timezone: 'المنطقة الزمنية',
  affected: 'عناصر متأثرة',
  unaffected: 'لم يتأثر',
  not_comparable: 'غير قابل للمقارنة',
  may_differ: 'قد يختلف لو أُعيد توليده',
  regenerated: 'أُعيد توليده',
  pages_total: 'عدد الصفحات',
  pages_ready: 'صفحات جاهزة',
  pages_failed: 'صفحات متعثرة',
  processing_status: 'حالة المعالجة',
  file_name: 'اسم الملف',
  format: 'الصيغة',
  source_type_origin: 'مصدر نوع المصدر',
  duplicate_of: 'نسخة مطابقة لـ',
  kind: 'النوع',
  page_indexes: 'الصفحات',
  username: 'اسم المستخدم',
  device_label: 'الجهاز',
};

const ORIGIN_AR: Record<string, string> = { auto: 'تلقائي', owner: 'أنت' };
/** readable values for the fields whose stored values are codes */
const VALUE_AR: Record<string, Record<string, string>> = {
  text_origin: TEXT_ORIGIN_LABELS_AR,
  status: { ...PROCESSING_STATUS_LABELS_AR, ...REGION_STATUS_LABELS_AR, ...REVIEW_ITEM_STATUS_LABELS_AR },
  processing_status: PROCESSING_STATUS_LABELS_AR,
  lecture_kind: LECTURE_KIND_LABELS_AR,
  lecture_kind_origin: ORIGIN_AR,
  source_type_origin: ORIGIN_AR,
  source_type: SOURCE_TYPE_LABELS_AR,
  kind: { ...LIBRARY_NODE_KIND_LABELS_AR },
};

const MAX_VALUE = 220;

function show(v: unknown): string | null {
  if (v === undefined) return null;
  if (v === null) return '—';
  if (typeof v === 'string') return oneLine(v, MAX_VALUE);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return oneLine(JSON.stringify(v), MAX_VALUE);
  } catch {
    return null;
  }
}

/** before/after objects → readable rows of the fields that changed (ids and internal bookkeeping left out). */
export function changesOf(before: unknown, after: unknown): HistoryEntryView['changes'] {
  const b = before && typeof before === 'object' && !Array.isArray(before) ? (before as Record<string, unknown>) : {};
  const a = after && typeof after === 'object' && !Array.isArray(after) ? (after as Record<string, unknown>) : {};
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => !/(^|_)id$|_ids?$|^correction_id$|^alert_id$|^job_id$/.test(k));
  const out: HistoryEntryView['changes'] = [];
  for (const k of keys) {
    const map = VALUE_AR[k];
    const bv = map && typeof b[k] === 'string' ? (map[b[k] as string] ?? show(b[k])) : show(b[k]);
    const av = map && typeof a[k] === 'string' ? (map[a[k] as string] ?? show(a[k])) : show(a[k]);
    if (bv === av) continue;
    out.push({ label: FIELD_LABELS_AR[k] ?? k, before: bv, after: av });
    if (out.length >= 8) break;
  }
  return out;
}

function linkFor(ctx: AppContext, entityType: string, entityId: string): ReviewLink | null {
  if (entityType === 'source') return { href: `/sources/${encodeURIComponent(entityId)}`, label_ar: 'افتح المصدر' };
  if (entityType === 'question') return { href: `/questions/${encodeURIComponent(entityId)}`, label_ar: 'افتح السؤال' };
  if (entityType === 'review_queue_item') {
    return ctx.db.get('SELECT 1 AS x FROM review_queue_item WHERE id = ?', [entityId]) ? { href: `/control/review/${encodeURIComponent(entityId)}`, label_ar: 'افتح عنصر المراجعة' } : null;
  }
  if (entityType === 'source_region' || entityType === 'source_page') {
    const r =
      entityType === 'source_region'
        ? ctx.db.get<{ source_id: string; version_id: string; page_index: number | null }>(
            'SELECT v.source_id, r.version_id, p.page_index FROM source_region r JOIN source_version v ON v.id = r.version_id LEFT JOIN source_page p ON p.id = r.page_id WHERE r.id = ?',
            [entityId],
          )
        : ctx.db.get<{ source_id: string; version_id: string; page_index: number | null }>(
            'SELECT v.source_id, p.version_id, p.page_index FROM source_page p JOIN source_version v ON v.id = p.version_id WHERE p.id = ?',
            [entityId],
          );
    if (!r) return null;
    const q = new URLSearchParams({ v: r.version_id });
    if (r.page_index !== null) q.set('page', String(r.page_index));
    return { href: `/study/${encodeURIComponent(r.source_id)}?${q.toString()}`, label_ar: 'افتح الصفحة' };
  }
  return null;
}

export function history(ctx: AppContext, q: { entity_type?: string; entity_id?: string; limit?: number; before?: string }): HistoryResponse {
  const res = ctx.audit.list({ entityType: q.entity_type, entityId: q.entity_id, limit: q.limit ?? 50, before: q.before });
  const entries: HistoryEntryView[] = res.entries.map((e) => ({
    id: e.id,
    at: e.created_at,
    entity_type: e.entity_type,
    entity_label_ar: ENTITY_LABELS_AR[e.entity_type] ?? e.entity_type,
    entity_id: e.entity_id,
    action: e.action,
    action_label_ar: ACTION_LABELS_AR[e.action] ?? e.action,
    summary: e.summary,
    actor: e.actor,
    actor_label_ar: ACTOR_LABELS_AR[e.actor] ?? e.actor,
    job_id: e.job_id,
    changes: changesOf(e.before, e.after),
    link: linkFor(ctx, e.entity_type, e.entity_id),
  }));
  const types = ctx.db.all<{ entity_type: string }>('SELECT DISTINCT entity_type FROM change_log ORDER BY entity_type LIMIT 100');
  return {
    entries,
    next_before: res.next_before,
    entity_types: types.map((t) => ({ value: t.entity_type, label_ar: ENTITY_LABELS_AR[t.entity_type] ?? t.entity_type })),
  };
}
