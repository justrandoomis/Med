// Arabic labels for page / region metadata shown in the rail («المصادر»).
import type { PageTextStatus, RegionKind, SourceRegionView, SourceVersionView } from '@medlevo/shared';
import { STATUS_LABELS_AR } from '@medlevo/shared';
import type { StatusTone } from '../../../design';

export const TEXT_STATUS_AR: Record<PageTextStatus, { label: string; tone: StatusTone }> = {
  pending: { label: 'لم يُستخرج النص بعد', tone: 'neutral' },
  digital: { label: 'نص رقمي من الملف', tone: 'success' },
  ocr: { label: 'نص مقروء آليًا (OCR)', tone: 'info' },
  mixed: { label: 'نص رقمي + OCR', tone: 'info' },
  no_text_found: { label: 'لم يوجد نص في الصفحة', tone: 'warning' },
  needs_ocr: { label: 'تحتاج قراءة آلية (OCR)', tone: 'warning' },
  failed: { label: 'فشل استخراج النص', tone: 'danger' },
};

export const PAGE_PROCESSING_AR: Record<string, { label: string; tone: StatusTone }> = {
  pending: { label: 'في انتظار المعالجة', tone: 'neutral' },
  processing: { label: 'قيد المعالجة', tone: 'info' },
  ready: { label: 'جاهزة', tone: 'success' },
  failed: { label: 'فشلت معالجتها', tone: 'danger' },
  needs_review: { label: 'تحتاج مراجعة', tone: 'warning' },
  skipped: { label: 'تُخطّيت', tone: 'neutral' },
};

export const REGION_KIND_AR: Record<RegionKind, string> = {
  text_block: 'كتلة نص',
  heading: 'عنوان',
  paragraph: 'فقرة',
  list_item: 'عنصر قائمة',
  table: 'جدول',
  table_cell: 'خلية جدول',
  figure: 'شكل',
  caption: 'تعليق شكل',
  diagram: 'مخطط',
  question: 'سؤال',
  option: 'خيار',
  answer_key: 'مفتاح إجابة',
  transcript: 'تفريغ صوتي',
  note: 'ملاحظة',
  footer: 'تذييل',
  header: 'ترويسة',
};

export function regionStatus(status: SourceRegionView['status']): { label: string; tone: StatusTone } {
  const tone: StatusTone =
    status === 'checks_passed' || status === 'owner_reviewed' ? 'success' : status === 'needs_review' || status === 'uncertain' ? 'warning' : status === 'rejected' ? 'danger' : 'neutral';
  return { label: STATUS_LABELS_AR[status as keyof typeof STATUS_LABELS_AR] ?? status, tone };
}

export const VERSION_KIND_AR: Record<SourceVersionView['kind'], string> = {
  original: 'الأصل',
  converted: 'نسخة محوّلة',
  ocr_correction: 'تصحيح OCR',
  owner_correction: 'تصحيح شخصي',
  replacement: 'ملف بديل',
};

export function versionLabel(v: Pick<SourceVersionView, 'version_no' | 'kind' | 'is_frozen'>): string {
  return `الإصدار ${v.version_no} — ${VERSION_KIND_AR[v.kind]}${v.is_frozen ? ' (مثبّت للدراسة)' : ''}`;
}
