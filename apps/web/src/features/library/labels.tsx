// Labels, counts and status presentation shared by the library, upload and sources screens.
// Status is always text + icon (never colour alone); counts are real numbers, never percentages.
import type { ReactNode } from 'react';
import { CircleAlert, CircleCheck, CircleDashed, Clock3, FileText, Image, Images, LoaderCircle, Mic, Presentation, ScrollText, TriangleAlert } from 'lucide-react';
import {
  SOURCE_TYPE_LABELS_AR,
  type ProcessingStatus,
  type SourceFormat,
  type SourceSummary,
} from '@medlevo/shared';
import { Bidi, StatusPill, type StatusTone } from '../../design';

/** Arabic counted noun with agreement (1 / 2 / 3–10 / 11+), Latin digits. */
export function countAr(n: number, forms: { one: string; two: string; few: string; many: string; zero?: string }): string {
  if (n === 0 && forms.zero) return forms.zero;
  if (n === 1) return forms.one;
  if (n === 2) return forms.two;
  const m = n % 100;
  if (m >= 3 && m <= 10) return `${n} ${forms.few}`;
  return `${n} ${forms.many}`;
}

export const NOUN = {
  page: { one: 'صفحة واحدة', two: 'صفحتان', few: 'صفحات', many: 'صفحة' },
  slide: { one: 'شريحة واحدة', two: 'شريحتان', few: 'شرائح', many: 'شريحة' },
  image: { one: 'صورة واحدة', two: 'صورتان', few: 'صور', many: 'صورة' },
  source: { one: 'مصدر واحد', two: 'مصدران', few: 'مصادر', many: 'مصدرًا', zero: 'لا مصادر' },
  folder: { one: 'مجلد واحد', two: 'مجلدان', few: 'مجلدات', many: 'مجلدًا' },
  file: { one: 'ملف واحد', two: 'ملفان', few: 'ملفات', many: 'ملفًا' },
} as const;

export const FORMAT_LABELS_AR: Record<SourceFormat, string> = {
  pdf: 'PDF',
  docx: 'Word',
  pptx: 'PowerPoint',
  image: 'صورة',
  image_set: 'مجموعة صور',
  audio: 'تسجيل صوتي',
  text: 'نص',
};

export function formatIcon(format: SourceFormat | null, size = 20): ReactNode {
  switch (format) {
    case 'pptx':
      return <Presentation size={size} />;
    case 'docx':
      return <ScrollText size={size} />;
    case 'image':
      return <Image size={size} />;
    case 'image_set':
      return <Images size={size} />;
    case 'audio':
      return <Mic size={size} />;
    default:
      return <FileText size={size} />;
  }
}

/** «4 صفحات» / «3 شرائح» / «12 صورة»; null when the format has no fixed pages (DOCX, audio). */
export function extentLabel(format: SourceFormat | null, count: number | null): string | null {
  if (count === null || count === undefined) return null;
  switch (format) {
    case 'pptx':
      return countAr(count, NOUN.slide);
    case 'image':
    case 'image_set':
      return countAr(count, NOUN.image);
    case 'pdf':
      return countAr(count, NOUN.page);
    default:
      return null;
  }
}

const STATUS: Record<ProcessingStatus, { label: string; tone: StatusTone; icon: ReactNode }> = {
  pending: { label: 'في انتظار المعالجة', tone: 'neutral', icon: <Clock3 size={14} /> },
  processing: { label: 'قيد المعالجة', tone: 'info', icon: <LoaderCircle size={14} /> },
  partial: { label: 'جاهز جزئيًا', tone: 'warning', icon: <CircleDashed size={14} /> },
  ready: { label: 'جاهز', tone: 'success', icon: <CircleCheck size={14} /> },
  failed: { label: 'فشلت المعالجة', tone: 'danger', icon: <CircleAlert size={14} /> },
  needs_review: { label: 'يحتاج مراجعة', tone: 'warning', icon: <TriangleAlert size={14} /> },
};

export function processingLabel(status: ProcessingStatus, format?: SourceFormat | null): string {
  if (format === 'audio' && status === 'partial') return 'محفوظ دون تفريغ نصي';
  return STATUS[status].label;
}

export function ProcessingPill({ status, format }: { status: ProcessingStatus; format?: SourceFormat | null }) {
  const s = STATUS[status];
  return (
    <StatusPill tone={s.tone} icon={s.icon}>
      {processingLabel(status, format)}
    </StatusPill>
  );
}

function subtitleParts(s: Pick<SourceSummary, 'source_type' | 'format' | 'page_count'>): string[] {
  const parts = [SOURCE_TYPE_LABELS_AR[s.source_type]];
  if (s.format) parts.push(FORMAT_LABELS_AR[s.format]);
  const extent = extentLabel(s.format, s.page_count);
  if (extent) parts.push(extent);
  return parts;
}

/** One-line description of a source (type, format, extent) as plain text. */
export function sourceSubtitle(s: Pick<SourceSummary, 'source_type' | 'format' | 'page_count'>): string {
  return subtitleParts(s).join('، ');
}

/** Same, with every part bidi-isolated so «PowerPoint، 3 شرائح» never reorders its digits. */
export function SourceSubtitle({ source }: { source: Pick<SourceSummary, 'source_type' | 'format' | 'page_count'> }) {
  return <IsolatedList parts={subtitleParts(source)} />;
}

/** Arabic comma-separated list whose items are each isolated (<bdi>). */
export function IsolatedList({ parts }: { parts: ReadonlyArray<ReactNode> }) {
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && '، '}
          <bdi>{p}</bdi>
        </span>
      ))}
    </>
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  const fmt = (v: number, digits: number) => (Number.isInteger(v) ? String(v) : v.toFixed(digits));
  if (n < 1024 * 1024 * 1024) return `${fmt(n / (1024 * 1024), 1)} MB`;
  return `${fmt(n / (1024 * 1024 * 1024), 2)} GB`;
}

/** A byte size as an isolated LTR run, so RTL text never shows «8 B» as «B 8» or swaps «1.5 MB». */
export function Bytes({ n }: { n: number }) {
  return <Bidi dir="ltr">{formatBytes(n)}</Bidi>;
}
