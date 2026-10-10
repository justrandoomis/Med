// Audit history viewer (§48, §56): the owner-visible change log in words — what changed, by whom (you / a job /
// the system), when, and the before → after facts. Secret-looking fields are redacted by the audit log itself.
import {
  ANSWER_STATUS_LABELS_AR,
  GENERATION_DIFFICULTY_LABELS_AR,
  LECTURE_KIND_LABELS_AR,
  LIBRARY_NODE_KIND_LABELS_AR,
  MISTAKE_TYPE_LABELS_AR,
  QUESTION_TYPE_LABELS_AR,
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
  page_indexes: 'صفحات الملف',
  username: 'اسم المستخدم',
  device_label: 'الجهاز',
  // counts and codes recorded by other modules (critic round: they used to appear as raw English keys)
  answer_status: 'حالة الإجابة',
  mistake_type: 'نوع الخطأ',
  qtype: 'نوع السؤال',
  difficulty: 'الصعوبة',
  stem: 'نص السؤال',
  label: 'التسمية',
  version_no: 'رقم الإصدار',
  count: 'العدد',
  items: 'عدد الأسئلة',
  questions: 'أسئلة مستخرجة',
  new_questions: 'أسئلة جديدة',
  attached: 'أُلحقت بأسئلة موجودة',
  keys_bound: 'مفاتيح رُبطت بأسئلتها',
  keys_unbound: 'مفاتيح لم تُربط',
  created: 'أُنشئ',
  skipped: 'تُخطّي',
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
  answer_status: ANSWER_STATUS_LABELS_AR,
  mistake_type: MISTAKE_TYPE_LABELS_AR,
  qtype: QUESTION_TYPE_LABELS_AR,
  difficulty: GENERATION_DIFFICULTY_LABELS_AR,
};

const MAX_VALUE = 220;

/**
 * One recorded value in words. Nested objects (an exam's policy, a build report, a settings map) are NOT dumped as
 * raw JSON — the entry's summary already says what happened in Arabic — so they yield `undefined` (row left out).
 * Arrays of plain values are listed; `page_indexes` are 0-based file positions, shown as the 1-based page numbers
 * the owner sees everywhere else.
 */
function show(v: unknown, key?: string): string | null | undefined {
  if (v === undefined) return null;
  if (v === null) return '—';
  if (typeof v === 'string') return oneLine(v, MAX_VALUE);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'نعم' : 'لا';
  if (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number')) {
    if (!v.length) return '—';
    const items = key === 'page_indexes' ? v.map((x) => (typeof x === 'number' ? String(x + 1) : x)) : v;
    return oneLine(items.join('، '), MAX_VALUE);
  }
  return undefined;
}

/**
 * before/after objects → readable rows of the fields that changed. Ids, internal bookkeeping, fields without an
 * Arabic label and nested objects are left out: the owner-facing log never shows raw keys or raw JSON (§48).
 */
export function changesOf(before: unknown, after: unknown): HistoryEntryView['changes'] {
  const b = before && typeof before === 'object' && !Array.isArray(before) ? (before as Record<string, unknown>) : {};
  const a = after && typeof after === 'object' && !Array.isArray(after) ? (after as Record<string, unknown>) : {};
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => !/(^|_)id$|_ids?$|^correction_id$|^alert_id$|^job_id$/.test(k));
  const out: HistoryEntryView['changes'] = [];
  const valueOf = (k: string, v: unknown): string | null | undefined => {
    if (k === 'duplicate_of') return v === undefined ? null : v ? 'مصدر موجود في مكتبتك' : '—';
    const map = VALUE_AR[k];
    return map && typeof v === 'string' ? (map[v] ?? show(v, k)) : show(v, k);
  };
  for (const k of keys) {
    const label = FIELD_LABELS_AR[k];
    if (!label) continue;
    const bv = valueOf(k, b[k]);
    const av = valueOf(k, a[k]);
    if (bv === undefined || av === undefined || bv === av) continue;
    out.push({ label, before: bv, after: av });
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
