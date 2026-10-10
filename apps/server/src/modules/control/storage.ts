// Server storage (§48 Storage & Offline): what the data directory holds, measured — the database files, the
// private file store by category (from stored_file rows that reference real blobs), backups, OCR models and
// temporary files. The browser's own offline storage is reported by the web (features/offline), not here.
import { lstatSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { StorageCategoryView, StorageResponse } from '@medlevo/shared';
import type { AppContext } from '../../context';

function fileSize(p: string): number {
  try {
    const s = statSync(p);
    return s.isFile() ? s.size : 0;
  } catch {
    return 0;
  }
}

/** Total size and file count of a directory tree (symlinks are not followed). Bounded to avoid runaway walks. */
function dirUsage(dir: string, limit = 200_000): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  let seen = 0;
  while (stack.length && seen < limit) {
    const d = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      continue;
    }
    for (const e of entries) {
      seen++;
      const p = join(d, e);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) stack.push(p);
      else if (st.isFile()) {
        bytes += st.size;
        files++;
      }
    }
  }
  return { bytes, files };
}

const CATEGORY_SQL = `
  SELECT f.id, f.size,
    CASE
      WHEN EXISTS (SELECT 1 FROM source_version v WHERE v.file_id = f.id OR v.original_file_id = f.id) THEN 'source_files'
      WHEN EXISTS (SELECT 1 FROM source_version v WHERE v.display_file_id = f.id) THEN 'display_pdfs'
      WHEN EXISTS (SELECT 1 FROM source_page p WHERE p.render_file_id = f.id OR p.thumbnail_file_id = f.id) THEN 'page_images'
      WHEN EXISTS (SELECT 1 FROM image_asset i WHERE i.file_id = f.id) THEN 'figure_crops'
      ELSE 'other'
    END AS category
  FROM stored_file f`;

const LABELS: Record<string, { label: string; note?: string }> = {
  source_files: { label: 'ملفات المصادر الأصلية', note: 'ما رفعته كما هو؛ لا يُعدَّل أبدًا.' },
  display_pdfs: { label: 'نسخ عرض PDF', note: 'تحويل الشرائح وملفات Word القديمة إلى صفحات ثابتة للقراءة.' },
  page_images: { label: 'صور الصفحات المعالجة', note: 'صور الصفحات الممسوحة المستخدمة للقراءة الآلية (OCR).' },
  figure_crops: { label: 'صور الأشكال المقتطعة', note: 'الأشكال والرسوم المقتطعة من الصفحات.' },
  other: { label: 'ملفات أخرى', note: 'مرفقات لا ترتبط بصفحة مصدر (مثل صور الملاحظات).' },
};

export function storageReport(ctx: AppContext): StorageResponse {
  const { dataDir, dbPath, filesDir, tmpDir } = ctx.config;
  const dbBytes = fileSize(dbPath) + fileSize(`${dbPath}-wal`) + fileSize(`${dbPath}-shm`);
  const dbFiles = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter((p) => fileSize(p) > 0).length;
  const byCat = new Map<string, { files: number; bytes: number }>();
  for (const r of ctx.db.all<{ id: string; size: number; category: string }>(CATEGORY_SQL)) {
    const c = byCat.get(r.category) ?? { files: 0, bytes: 0 };
    c.files++;
    c.bytes += r.size;
    byCat.set(r.category, c);
  }
  const categories: StorageCategoryView[] = Object.keys(LABELS)
    .filter((k) => byCat.has(k))
    .map((k) => ({ key: k, label_ar: LABELS[k]!.label, files: byCat.get(k)!.files, bytes: byCat.get(k)!.bytes, ...(LABELS[k]!.note ? { note_ar: LABELS[k]!.note } : {}) }));
  const store = dirUsage(filesDir);
  const filesBytes = categories.reduce((n, c) => n + c.bytes, 0);
  const filesCount = categories.reduce((n, c) => n + c.files, 0);
  const backups = dirUsage(join(dataDir, 'backups'));
  let archives = 0;
  try {
    archives = readdirSync(join(dataDir, 'backups')).filter((n) => n.endsWith('.tar.gz')).length;
  } catch {
    archives = 0;
  }
  const other: StorageCategoryView[] = [];
  const tess = dirUsage(join(dataDir, 'tessdata'));
  const tessCache = dirUsage(join(dataDir, 'tessdata-cache'));
  if (tess.files + tessCache.files > 0) {
    other.push({ key: 'ocr_models', label_ar: 'نماذج القراءة الآلية (OCR)', files: tess.files + tessCache.files, bytes: tess.bytes + tessCache.bytes, note_ar: 'نسخة محلية من نماذج اللغتين العربية والإنجليزية؛ لا تغادر الخادم.' });
  }
  const tmp = dirUsage(tmpDir);
  if (tmp.files > 0) other.push({ key: 'tmp', label_ar: 'ملفات مؤقتة', files: tmp.files, bytes: tmp.bytes, note_ar: 'ملفات رفع ومعالجة جارية؛ تُحذف بعد انتهائها.' });
  const notes = [
    'الأحجام مقيسة الآن من مجلد بيانات الخادم، وليست تقديرًا.',
    'الملفات مخزنة مرة واحدة حتى لو رفعتها أكثر من مرة (تخزين حسب المحتوى).',
    'التنزيلات للعمل دون اتصال تُحفظ في متصفح كل جهاز على حدة، وتظهر في «التنزيلات».',
  ];
  if (store.bytes > filesBytes) {
    notes.push(`في مخزن الملفات ${store.files - filesCount > 0 ? `${store.files - filesCount} ملفًا` : 'بيانات'} غير مسجّلة في قاعدة البيانات (بقايا عمليات سابقة)؛ لا تدخل في النسخ الاحتياطية.`);
  }
  return {
    database: { bytes: dbBytes, files: dbFiles },
    files: { count: filesCount, bytes: filesBytes, categories },
    backups: { count: archives, bytes: backups.bytes },
    other,
    total_bytes: dbBytes + Math.max(store.bytes, filesBytes) + backups.bytes + other.reduce((n, c) => n + c.bytes, 0),
    measured_at: ctx.clock.now(),
    notes_ar: notes,
  };
}
