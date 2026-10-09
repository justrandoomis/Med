// Presentation of per-file upload outcomes (pure; unit-tested).
import { SOURCE_TYPE_LABELS_AR, type UploadFileResult } from '@medlevo/shared';
import type { StatusTone } from '../../design';
import { formatBytes } from '../library/labels';

export type QueueStatus = 'waiting' | 'uploading' | 'checking' | 'accepted' | 'rejected' | 'duplicate' | 'error';

export interface QueueItem {
  key: string;
  file: File;
  status: QueueStatus;
  sent: number;
  total: number;
  result?: UploadFileResult;
  error?: string;
  /** re-upload of a duplicate the owner explicitly wants as a separate copy */
  forceCopy?: boolean;
}

const DETECTED_AR: Record<NonNullable<UploadFileResult['detected_format']>, string> = {
  pdf: 'PDF',
  docx: 'Word (DOCX)',
  pptx: 'PowerPoint (PPTX)',
  image: 'صورة',
  image_set: 'مجموعة صور',
  audio: 'تسجيل صوتي',
  text: 'نص',
  doc: 'Word قديم (DOC)',
  ppt: 'PowerPoint قديم (PPT)',
  zip: 'أرشيف ZIP',
  unknown: 'غير معروف',
};

export interface StatusView {
  tone: StatusTone;
  label: string;
  /** one line under the file name */
  detail: string | null;
}

export function describeItem(item: QueueItem): StatusView {
  switch (item.status) {
    case 'waiting':
      return { tone: 'neutral', label: 'في الانتظار', detail: formatBytes(item.file.size) };
    case 'uploading':
      return { tone: 'info', label: 'يُرفع', detail: `${formatBytes(item.sent)} من ${formatBytes(item.total || item.file.size)}` };
    case 'checking':
      return { tone: 'info', label: 'يفحصه الخادم', detail: 'التحقق من نوع الملف ومحتواه…' };
    case 'error':
      return { tone: 'danger', label: 'تعذّر الرفع', detail: item.error ?? null };
    default:
      return describeResult(item.result!);
  }
}

export function describeResult(r: UploadFileResult): StatusView {
  const detected = r.detected_format ? DETECTED_AR[r.detected_format] : null;
  switch (r.status) {
    case 'accepted': {
      const parts = [detected ? `اكتُشف: ${detected}` : null, r.suggested_source_type ? `النوع المقترح: ${SOURCE_TYPE_LABELS_AR[r.suggested_source_type]}` : null];
      if (r.duplicate_of) parts.push('أُضيف كنسخة مستقلة لمحتوى موجود');
      return { tone: 'success', label: 'قُبل', detail: parts.filter(Boolean).join('، ') || null };
    }
    case 'duplicate':
      return { tone: 'warning', label: 'موجود مسبقًا', detail: r.reason_ar ?? (r.duplicate_of ? `المحتوى نفسه موجود في «${r.duplicate_of.title}».` : null) };
    case 'rejected':
      return { tone: 'danger', label: 'رُفض', detail: r.reason_ar ?? 'رُفض الملف.' };
  }
}

/** Summary line after a batch, e.g. «قُبل 2، رُفض 1، موجود مسبقًا 1». */
export function batchSummary(items: readonly QueueItem[]): string | null {
  const done = items.filter((i) => ['accepted', 'rejected', 'duplicate', 'error'].includes(i.status));
  if (done.length === 0) return null;
  const n = (s: QueueStatus) => done.filter((i) => i.status === s).length;
  const parts = [
    n('accepted') ? `قُبل ${n('accepted')}` : null,
    n('rejected') ? `رُفض ${n('rejected')}` : null,
    n('duplicate') ? `موجود مسبقًا ${n('duplicate')}` : null,
    n('error') ? `تعذّر رفع ${n('error')}` : null,
  ].filter(Boolean);
  return parts.join('، ');
}
