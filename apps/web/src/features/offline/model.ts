// Pure helpers for the Download Manager / backups / export screens (tested in model.test.ts).
import type { BackupView, OfflineManifestResponse, SourceSummary } from '@medlevo/shared';
import { formatBytes } from '../../lib/offline';

/** Arabic count phrases with correct agreement for the few nouns this screen uses. */
export function countAr(n: number, one: string, two: string, few: string, many: string): string {
  if (n === 0) return `لا ${many}`;
  if (n === 1) return one;
  if (n === 2) return two;
  if (n >= 3 && n <= 10) return `${n} ${few}`;
  return `${n} ${many}`;
}

export const pagesAr = (n: number) => countAr(n, 'صفحة واحدة', 'صفحتان', 'صفحات', 'صفحة');
export const questionsAr = (n: number) => countAr(n, 'سؤال واحد', 'سؤالان', 'أسئلة', 'سؤالًا');
export const cardsAr = (n: number) => countAr(n, 'بطاقة واحدة', 'بطاقتان', 'بطاقات', 'بطاقة');
export const reviewsAr = (n: number) => countAr(n, 'مراجعة واحدة', 'مراجعتان', 'مراجعات', 'مراجعة');
export const notesAr = (n: number) => countAr(n, 'ملاحظة واحدة', 'ملاحظتان', 'ملاحظات', 'ملاحظة');
export const marksAr = (n: number) => countAr(n, 'عنصر كتابة واحد', 'عنصرا كتابة', 'عناصر كتابة', 'عنصر كتابة');
export const changesAr = (n: number) => countAr(n, 'تغيير واحد', 'تغييران', 'تغييرات', 'تغييرًا');
export const filesAr = (n: number) => countAr(n, 'ملف واحد', 'ملفان', 'ملفات', 'ملفًا');

export interface ContentLine {
  key: string;
  text: string;
  /** exact size in bytes when known */
  bytes?: number;
  solutions?: boolean;
}

/** What a download holds, line by line, with real sizes from the manifest. */
export function manifestLines(m: OfflineManifestResponse): ContentLine[] {
  const lines: ContentLine[] = [];
  const fileBytes = (role: string) => m.entries.filter((e) => e.kind === 'file' && e.role === role).reduce((a, e) => a + e.size, 0);
  const dataBytes = (roles: string[]) => m.entries.filter((e) => e.kind === 'data' && roles.includes(e.role)).reduce((a, e) => a + e.size, 0);
  if (m.contents.has_display_pdf) lines.push({ key: 'pdf', text: 'ملف PDF للعرض كما في الأصل', bytes: fileBytes('display_pdf') });
  if (m.contents.page_images) lines.push({ key: 'images', text: `صور الصفحات (${pagesAr(m.contents.page_images)})`, bytes: fileBytes('page_image') });
  lines.push({ key: 'pages', text: `نص ${pagesAr(m.contents.pages)} ومناطقها (للبحث والتحديد ورقم الصفحة)`, bytes: dataBytes(['source_detail', 'pages', 'page_regions']) });
  const writing = m.contents.annotations + m.contents.notes;
  lines.push({
    key: 'writing',
    text: writing ? `كتاباتك على المصدر: ${marksAr(m.contents.annotations)} و${notesAr(m.contents.notes)}` : 'لا توجد كتابات لك على هذا المصدر بعد',
    bytes: dataBytes(['annotations', 'notes', 'needs_reanchor', 'latest_session', 'reading_progress']),
  });
  if (m.contents.study_book) {
    lines.push({
      key: 'book',
      text: `كتاب الدراسة (الإصدار ${m.contents.study_book.version_no}${m.contents.study_book.is_frozen ? '، مثبّت' : ''}) مع الأدلة التي يستشهد بها`,
      bytes: dataBytes(['study_book_status', 'study_book']),
    });
  }
  if (m.contents.questions.linked) {
    lines.push({
      key: 'questions',
      text: m.contents.questions.with_solutions
        ? `${questionsAr(m.contents.questions.linked)} مرتبطة بالمحاضرة — مع الحلول ومفاتيح الإجابة`
        : `${questionsAr(m.contents.questions.linked)} مرتبطة بالمحاضرة — دون الحلول`,
      bytes: dataBytes(['lecture_questions', 'question_detail']),
      solutions: m.contents.questions.with_solutions > 0,
    });
  }
  if (m.contents.flashcards) lines.push({ key: 'cards', text: `${cardsAr(m.contents.flashcards)} و${reviewsAr(m.contents.review_events)} من سجلها`, bytes: dataBytes(['learning']) });
  return lines;
}

/** Sources that can be downloaded, lectures first then by recent use; trashed / never-processed ones excluded. */
export function downloadableSources(sources: SourceSummary[], q: string): SourceSummary[] {
  const norm = (s: string) => s.toLowerCase().normalize('NFKC');
  const needle = norm(q.trim());
  const typeRank = (t: string) => (t === 'lecture' ? 0 : t === 'question_source' || t === 'previous_exam' ? 2 : 1);
  return sources
    .filter((s) => !s.deleted_at && s.active_version_id && s.format !== 'audio' && s.processing_status !== 'pending' && (!needle || norm(s.title).includes(needle)))
    .sort((a, b) => typeRank(a.source_type) - typeRank(b.source_type) || (b.last_opened_at ?? 0) - (a.last_opened_at ?? 0) || a.title.localeCompare(b.title, 'ar'));
}

/** «يستخدم هذا الموقع 25 MB من نحو 1.2 GB متاحة (تقدير المتصفح)» parts, for <Bidi> rendering. */
export function storageSummary(est: { usage: number; quota: number } | null): { used: string; quota: string } | null {
  if (!est || est.quota <= 0) return null;
  return { used: formatBytes(est.usage), quota: formatBytes(est.quota) };
}

export function backupTone(b: BackupView): 'success' | 'warning' | 'danger' | 'neutral' {
  if (b.status === 'failed') return 'danger';
  if (b.status === 'completed_with_warnings') return 'warning';
  if (b.status === 'completed') return b.verification?.status === 'failed' ? 'warning' : 'success';
  return 'neutral';
}

/** File name from a Content-Disposition header (RFC 5987 filename* first). */
export function fileNameFrom(disposition: string | null, fallback: string): string {
  if (!disposition) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim());
    } catch {
      // fall through
    }
  }
  const plain = /filename="([^"]+)"/i.exec(disposition);
  return plain?.[1] ?? fallback;
}

export const STORAGE_POLICY_AR = [
  'لا يحذف التطبيق أي تنزيل تلقائيًا؛ الإزالة تكون بيدك فقط.',
  'إزالة تنزيل تحذف نسخة الملف والصفحات من هذا الجهاز فقط. كتاباتك وملاحظاتك ومحاولاتك تبقى، وما لم يُزامَن منها لا يُحذف أبدًا.',
  'التنزيل نسخة مؤقتة للعمل دون اتصال، وليس نسخة احتياطية: النسخ الاحتياطي من تبويب «النسخ الاحتياطي».',
  'إن لم يكن التخزين دائمًا فقد يحذف المتصفح بيانات هذا الموقع كلها عند امتلاء الجهاز — ومنها ما لم يُزامَن بعد. لذلك يمكنك طلب التخزين الدائم.',
];
