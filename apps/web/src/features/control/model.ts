// Pure helpers of the Personal Control Center: sections, number formats (Latin digits, LTR-isolated by the
// views), readable descriptions of sync problems (what happened, what each action does), and status lines.
import { parseRichText, richTextToPlain, type ControlOverviewResponse } from '@medlevo/shared';
import type { OutboxRecord } from '../../lib/localdb';

export type SectionKey = 'review' | 'alerts' | 'sync' | 'processing' | 'sources' | 'intelligence' | 'storage' | 'profile' | 'capabilities' | 'history';

export interface SectionDef {
  key: SectionKey;
  label: string;
  /** absolute app path */
  href: string;
  /** shown under the label in the index */
  purpose: string;
  /** leaves the control center (another screen owns it) */
  external?: boolean;
}

export const SECTIONS: SectionDef[] = [
  { key: 'review', label: 'قائمة المراجعة', href: '/control/review', purpose: 'ما استُخرج ويحتاج قرارك: نص مقروء، صفحات، تصنيفات، أسئلة.' },
  { key: 'alerts', label: 'تنبيهات المحتوى', href: '/control/alerts', purpose: 'ما تغيّر في مصادرك وما يعتمد عليه.' },
  { key: 'sync', label: 'التعارضات والمزامنة', href: '/control/sync', purpose: 'تغييرات هذا الجهاز التي لم تصل كما هي.' },
  { key: 'processing', label: 'المعالجة', href: '/control/processing', purpose: 'المهام الجارية والصفحات المتعثرة وأسبابها.' },
  { key: 'sources', label: 'المصادر والأولويات', href: '/control/sources', purpose: 'من أين يبدأ البحث عن الأدلة لكل مهمة.' },
  { key: 'intelligence', label: 'الذكاء الاصطناعي', href: '/control/intelligence', purpose: 'النماذج والميزانية والاستخدام وقواعد الشرح.' },
  { key: 'storage', label: 'التخزين ودون اتصال', href: '/control/storage', purpose: 'مساحة الخادم وهذا الجهاز والتنزيلات.' },
  { key: 'profile', label: 'ملف التعلّم', href: '/review/profile', purpose: 'ما تستخدمه المنصة لتخصيص تعلمك، وتعديله.', external: true },
  { key: 'capabilities', label: 'القدرات', href: '/control/capabilities', purpose: 'ما يعمل الآن وما لا يعمل ولماذا.' },
  { key: 'history', label: 'السجل', href: '/control/history', purpose: 'ما تغيّر في بياناتك، ومتى، وبيد من.' },
];

export const ATTENTION_KEYS: SectionKey[] = ['review', 'alerts', 'sync', 'processing'];

const LATN = 'ar-u-nu-latn';

/** «1,234» (Latin digits, never Arabic-Indic, so numbers read the same as the sources). */
export function formatCount(n: number): string {
  return new Intl.NumberFormat(LATN).format(n);
}

/** «$0.0123» — always an ESTIMATE in this app; the views say so next to it. */
export function formatUsd(n: number): string {
  const digits = n === 0 ? 2 : n < 0.01 ? 4 : n < 1 ? 3 : 2;
  return `$${n.toFixed(digits)}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Arabic count phrase with correct agreement for the common nouns used here. */
export function countAr(n: number, one: string, two: string, few: string, many: string): string {
  if (n === 0) return `لا ${one}`;
  if (n === 1) return `${one} واحد`;
  if (n === 2) return two;
  if (n <= 10) return `${n} ${few}`;
  return `${n} ${many}`;
}

export function itemsAr(n: number): string {
  if (n === 1) return 'عنصر واحد';
  if (n === 2) return 'عنصران';
  if (n <= 10) return `${n} عناصر`;
  return `${n} عنصرًا`;
}

/** One calm sentence of state per section (real counts only). */
export function statusLine(key: SectionKey, o: ControlOverviewResponse | null, local: { conflicts: number; errors: number; pending: number } | null): string | null {
  if (key === 'sync') {
    if (!local) return null;
    if (local.conflicts + local.errors === 0) return local.pending ? `${itemsAr(local.pending)} بانتظار الإرسال، دون مشكلات.` : 'لا مشكلات مزامنة على هذا الجهاز.';
    return `${itemsAr(local.conflicts + local.errors)} بانتظار قرارك على هذا الجهاز.`;
  }
  if (!o) return null;
  switch (key) {
    case 'review':
      return o.review.open ? `${itemsAr(o.review.open)} بانتظار مراجعتك.` : 'لا شيء ينتظر مراجعتك.';
    case 'alerts':
      return o.alerts.open ? `${o.alerts.open === 1 ? 'تنبيه جديد' : o.alerts.open === 2 ? 'تنبيهان جديدان' : `${o.alerts.open} تنبيهات جديدة`} عن تغيّر المحتوى.` : 'لا تنبيهات جديدة.';
    case 'processing': {
      const parts: string[] = [];
      if (o.processing.active) parts.push(o.processing.active === 1 ? 'مهمة واحدة جارية' : `${o.processing.active} مهام جارية`);
      if (o.processing.attention) parts.push(o.processing.attention === 1 ? 'نسخة واحدة تغطيتها غير كاملة أو تحتاج مراجعة' : `${o.processing.attention} نسخ تغطيتها غير كاملة أو تحتاج مراجعة`);
      if (o.processing.failed) parts.push(o.processing.failed === 1 ? 'مهمة فشلت مؤخرًا' : `${o.processing.failed} مهام فشلت مؤخرًا`);
      return parts.length ? `${parts.join('، ')}.` : 'لا مهام جارية ولا صفحات متعثرة.';
    }
    case 'intelligence':
      return o.ai.configured ? `التكلفة التقديرية هذا الشهر ${formatUsd(o.ai.spent_usd)} من ${formatUsd(o.ai.monthly_usd)}.` : 'غير مهيأ على الخادم؛ الميزات الحتمية تعمل دونه.';
    default:
      return null;
  }
}

// ───────── sync problems (lib/sync.ts outbox) ─────────
export const SYNC_ENTITY_LABELS_AR: Record<string, string> = {
  annotation: 'كتابة أو تظليل على الصفحة',
  note: 'ملاحظة',
  note_page: 'صفحة ملاحظات',
  flashcard: 'بطاقة',
  review_event: 'مراجعة بطاقة',
  question_attempt: 'إجابة سؤال',
  study_session: 'جلسة دراسة',
  exam_attempt: 'محاولة اختبار',
};

/** the same, definite (for sentences: «عدّلتَ الملاحظة…») */
const SYNC_ENTITY_DEFINITE_AR: Record<string, string> = {
  annotation: 'الكتابة أو التظليل',
  note: 'الملاحظة',
  note_page: 'صفحة الملاحظات',
  flashcard: 'البطاقة',
  review_event: 'مراجعة البطاقة',
  question_attempt: 'إجابة السؤال',
  study_session: 'جلسة الدراسة',
  exam_attempt: 'محاولة الاختبار',
};

const OP_LABELS_AR: Record<string, string> = { upsert: 'تعديل', delete: 'حذف', append: 'إضافة' };

export interface SyncIssueView {
  opId: string;
  entityLabel: string;
  opLabel: string;
  kind: 'conflict' | 'rejected';
  /** what happened, in words */
  happened: string;
  /** server's own reason, when it gave one */
  serverReason: string | null;
  /** a short excerpt of what this device tried to save */
  preview: string | null;
  at: number;
  canRetry: boolean;
  acknowledgeLabel: string;
  acknowledgeEffect: string;
  retryEffect: string;
}

function textOf(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (v && typeof v === 'object') {
    try {
      const plain = richTextToPlain(parseRichText(v));
      return plain.trim() || null;
    } catch {
      return null;
    }
  }
  return null;
}

function excerpt(s: string | null, max = 140): string | null {
  if (!s) return null;
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function payloadPreview(op: Pick<OutboxRecord, 'entity_type' | 'payload'>): string | null {
  const p = op.payload && typeof op.payload === 'object' ? (op.payload as Record<string, unknown>) : null;
  if (!p) return null;
  const title = textOf(p.title);
  const body = textOf(p.body) ?? textOf(p.front);
  const data = p.data && typeof p.data === 'object' ? textOf((p.data as Record<string, unknown>).text) : null;
  if (title && body) return excerpt(`${title}: ${body}`);
  return excerpt(title ?? body ?? data);
}

function detailText(detail: unknown): string | null {
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  if (detail && typeof detail === 'object' && typeof (detail as { message?: unknown }).message === 'string') return (detail as { message: string }).message;
  return null;
}

export function describeSyncIssue(op: OutboxRecord): SyncIssueView {
  const entityLabel = SYNC_ENTITY_LABELS_AR[op.entity_type] ?? op.entity_type;
  const the = SYNC_ENTITY_DEFINITE_AR[op.entity_type] ?? 'هذا العنصر';
  const kind: SyncIssueView['kind'] = op.status === 'conflict' ? 'conflict' : 'rejected';
  const serverReason = detailText(op.resultDetail) ?? (op.lastError ? op.lastError : null);
  let happened: string;
  if (kind === 'conflict' && op.result === 'conflict_kept_both') {
    happened = `عدّلتَ ${the} على هذا الجهاز بينما تغيّرت نسختها على الخادم (من جهاز آخر). لم يكتب أي منهما فوق الآخر: احتفظ الخادم بالنسختين، ونسختك محفوظة كنسخة منفصلة.`;
  } else if (kind === 'conflict') {
    happened = `على الخادم نسخة أحدث من ${the}، فلم يكتب تغييرك فوقها. بقي تغييرك على هذا الجهاز كما هو.`;
  } else {
    happened = `رفض الخادم هذا التغيير، فلم يُحفظ على الخادم. ما زال موجودًا على هذا الجهاز ولم يُحذف.`;
  }
  // two kinds of conflict: the server SAVED both copies (conflict_kept_both), or it kept its newer copy and refused
  // this change (rejected with the server copy: reading position, note page settings, exam attempt state). A re-send
  // of the latter carries the same old base and can only be refused again — no retry is offered for it.
  const keptBoth = kind === 'conflict' && op.result === 'conflict_kept_both';
  const ackLabel = kind === 'conflict' ? 'اطّلعت — أبقِ النسختين' : 'اطّلعت — لا ترسله';
  const ackEffect = keptBoth
    ? 'يُغلق هذا التنبيه فقط. تبقى النسختان كما هما (نسختك ونسخة الخادم) ولا يُحذف شيء؛ يمكنك دمجهما بنفسك لاحقًا.'
    : kind === 'conflict'
      ? 'يُغلق هذا التنبيه فقط. نسخة الخادم الأحدث تبقى على الخادم، وتغييرك يبقى على هذا الجهاز ولن يُرسل مرة أخرى. لا يُحذف شيء.'
      : 'يُغلق هذا التنبيه ولن يُرسل التغيير مرة أخرى. يبقى على هذا الجهاز كما هو، والخادم لا يملكه. لا يُحذف شيء.';
  const retryEffect = keptBoth
    ? 'يُرسل تعديلك مرة أخرى كعملية جديدة على أساس النسخة القديمة نفسها. إن بقيت نسخة الخادم أحدث فسيحتفظ الخادم بنسخة إضافية بدل الكتابة فوقها، فقد تظهر نسخة ثالثة. لا يُحذف شيء.'
    : 'يُرسل التغيير نفسه مرة أخرى كعملية جديدة (الخادم لا يطبّق العملية الواحدة مرتين). استخدمه بعد إصلاح سبب الرفض، وإلا فسيُرفض مرة أخرى.';
  return {
    opId: op.op_id,
    entityLabel,
    opLabel: OP_LABELS_AR[op.op] ?? op.op,
    kind,
    happened,
    serverReason,
    preview: payloadPreview(op),
    at: op.client_ts,
    canRetry: !op.supersededBy && (kind === 'rejected' || keptBoth),
    acknowledgeLabel: ackLabel,
    acknowledgeEffect: ackEffect,
    retryEffect,
  };
}

/** Confidence 0–1 → «ثقة القراءة 62 %» only when the extractor reported one (never invented). */
export function confidenceLabel(c: number | null | undefined): string | null {
  if (typeof c !== 'number' || !Number.isFinite(c)) return null;
  return `ثقة القراءة الآلية ${Math.round(c * 100)}%`;
}
