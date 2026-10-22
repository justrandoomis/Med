// The Arabic line of each notification, rendered at READ time from kind + payload (P1-T4 step 2; IA_AND_JOURNEYS §4.9).
// Payloads hold titles and counts only, so the line never says more than the payload; titles sit inside «» and the
// client isolates English runs itself (AC-20 — no bidi control is ever stored or added here).
import { type NotificationContent, REPORT_REASON_LABELS_AR } from '@medlevo/shared';

const n = (x: number) => String(x);

const DECISION_AR = { approved: 'قُبل طلب انضمامك إلى', rejected: 'رُفض طلب انضمامك إلى', removed: 'أُزلت من' } as const;
const SUBJECT_EVENT_AR = {
  lecture_withdrawn: 'سُحبت محاضرة',
  attachment_published: 'ملف جديد',
  exam_date_published: 'موعد امتحان جديد',
  exam_date_changed: 'تغيّر موعد امتحان',
} as const;
const QUOTA_AR = { storage: 'من مساحة التخزين', ai: 'من رصيد الذكاء الاصطناعي لهذا الشهر', asr: 'من رصيد تفريغ التسجيلات لهذا الشهر' } as const;

export function notificationText(c: NotificationContent): string {
  switch (c.kind) {
    case 'join_requested': {
      const more = c.payload.pending_count && c.payload.pending_count > 1 ? ` (${n(c.payload.pending_count)} طلبات بانتظار القرار)` : '';
      return `طلب انضمام جديد إلى «${c.payload.node_title}»${more}`;
    }
    case 'join_decided':
      return `${DECISION_AR[c.payload.decision]} «${c.payload.node_title}»`;
    case 'invitation':
      return `دعوة للانضمام إلى «${c.payload.node_title}»`;
    case 'official_lecture_new': {
      const no = c.payload.lecture_no !== null ? `المحاضرة ${n(c.payload.lecture_no)}: ` : '';
      return `محاضرة رسمية جديدة في «${c.payload.subject_title}»: ${no}«${c.payload.lecture_title}»`;
    }
    case 'official_version':
      return `إصدار جديد (${n(c.payload.version_no)}) من «${c.payload.lecture_title}» في «${c.payload.subject_title}»`;
    case 'subject_update':
      return `${SUBJECT_EVENT_AR[c.payload.event_kind]} في «${c.payload.subject_title}»: «${c.payload.title}»`;
    case 'publication_updated':
      return `تحديث الشرح «${c.payload.publication_title}» (الإصدار ${n(c.payload.version_no)}): أضيف ${n(c.payload.added)}، حُذف ${n(c.payload.removed)}، عُدّل ${n(c.payload.changed)}`;
    case 'moderation': {
      const p = c.payload;
      if (p.as === 'author') {
        const verb = p.action === 'hide' ? 'أخفى المشرف' : p.action === 'restore' ? 'أعاد المشرف إظهار' : 'راجع المشرف';
        return `${verb} «${p.target_title}». السبب: ${p.reason_ar}`;
      }
      const outcome = p.action === 'hide' ? 'وأخفوا المحتوى' : p.action === 'restore' ? 'وأعادوا إظهاره' : 'ولم يجدوا مخالفة';
      return `راجع المشرفون بلاغك عن «${p.target_title}» ${outcome}. السبب: ${p.reason_ar}`;
    }
    case 'report_received':
      return `بلاغ جديد في «${c.payload.subject_title}» عن «${c.payload.target_title}» (${REPORT_REASON_LABELS_AR[c.payload.reason]}). البلاغات المفتوحة: ${n(c.payload.open_reports)}`;
    case 'reanchor_ready':
      return `اكتمل نقل ملاحظاتك في «${c.payload.lecture_title}»: نُقل ${n(c.payload.copied)}، وللمراجعة ${n(c.payload.needs_review)}، وبقي في مكانه ${n(c.payload.kept)}`;
    case 'quota_warning':
      return c.payload.percent === 100 ? `استنفدت ${QUOTA_AR[c.payload.quota]}` : `استخدمت ${n(c.payload.percent)}٪ ${QUOTA_AR[c.payload.quota]}`;
  }
}
