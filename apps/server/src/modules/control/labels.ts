// Arabic labels used by the Personal Control Center (readable explanations, never raw codes only — §48, §56).
import { JOB_STATUS_LABELS_AR, PROCESS_JOB_KIND, STATUS_LABELS_AR, type JobStatus } from '@medlevo/shared';

export const REGION_KIND_LABELS_AR: Record<string, string> = {
  text_block: 'فقرة نصية',
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
  note: 'ملاحظات المتحدث',
  footer: 'تذييل الصفحة',
  header: 'ترويسة الصفحة',
};

export const TEXT_ORIGIN_LABELS_AR: Record<string, string> = {
  digital: 'نص رقمي من الملف',
  ocr: 'مقروء آليًا (OCR)',
  owner: 'كتبته أو صحّحته بنفسك',
  vision: 'قراءة بصرية مولّدة (ليست دليلًا)',
};

export const REGION_STATUS_LABELS_AR: Record<string, string> = {
  ...STATUS_LABELS_AR,
  extracted: 'مستخرج',
  checks_passed: 'اجتاز فحوص الاستخراج',
  needs_review: 'يحتاج مراجعة',
  uncertain: 'غير مؤكد',
  owner_reviewed: 'راجعته شخصيًا',
  rejected: 'مستبعد',
};

export const PAGE_TEXT_STATUS_LABELS_AR: Record<string, string> = {
  pending: 'لم يُعالج بعد',
  digital: 'نص رقمي',
  ocr: 'مقروء آليًا (OCR)',
  mixed: 'رقمي ومقروء آليًا',
  no_text_found: 'لم يُعثر على نص',
  needs_ocr: 'يحتاج قراءة آلية (OCR) غير متاحة',
  failed: 'تعذرت القراءة',
};

export const PROCESSING_STATUS_LABELS_AR: Record<string, string> = {
  pending: 'بانتظار المعالجة',
  processing: 'قيد المعالجة',
  partial: 'اكتملت جزئيًا',
  ready: 'جاهز',
  failed: 'تعذرت المعالجة',
  needs_review: 'جاهز مع صفحات تحتاج مراجعتك',
};

export const CORRECTION_ACTION_LABELS_AR: Record<string, string> = {
  correct: 'صحّحت النص',
  accept: 'أكّدت النص كما استُخرج',
  reject: 'استبعدت النص',
  owner_text: 'كتبت نص الصفحة بنفسك',
};

/** job kinds → what the job does (readable), keyed by the kinds the modules register. */
export const JOB_KIND_LABELS_AR: Record<string, { label: string; explain: string }> = {
  [PROCESS_JOB_KIND]: { label: 'معالجة مصدر', explain: 'قراءة صفحات الملف واستخراج النص والجداول والأشكال وبناء فهرس البحث.' },
  generate_study_book: { label: 'بناء كتاب الدراسة', explain: 'توليد أقسام كتاب الدراسة من المحاضرة مع التحقق من كل ادعاء.' },
  generate_summary: { label: 'ملخص', explain: 'توليد ملخص من الصفحات المختارة مع ذكر ما لم يُغطَّ.' },
  extract_questions: { label: 'استخراج الأسئلة', explain: 'قراءة الأسئلة والخيارات ومفاتيح الإجابة من مصدر الأسئلة.' },
  match_questions: { label: 'ربط الأسئلة بالمحاضرات', explain: 'البحث عن المحاضرة التي تغطي كل سؤال.' },
  'exams.generate_questions': { label: 'توليد أسئلة', explain: 'توليد أسئلة من المادة والتحقق منها قبل النشر؛ ما لا يجتاز الفحص لا يُنشر.' },
  data_backup: { label: 'نسخة احتياطية', explain: 'نسخ قاعدة البيانات والملفات في أرشيف واحد مع التحقق منه.' },
  data_backup_verify: { label: 'اختبار استعادة نسخة احتياطية', explain: 'فك النسخة في مجلد مؤقت والتحقق من سلامة كل ما فيها.' },
};

export function jobKindLabel(kind: string): { label: string; explain: string } {
  return JOB_KIND_LABELS_AR[kind] ?? { label: kind.replace(/_/g, ' '), explain: 'مهمة خلفية على الخادم.' };
}

export function jobStatusLabel(s: JobStatus): string {
  return JOB_STATUS_LABELS_AR[s] ?? s;
}

const UNIT_AR: Record<string, [string, string]> = {
  pages: ['صفحة', 'صفحات'],
  items: ['عنصر', 'عناصر'],
  sections: ['قسم', 'أقسام'],
  questions: ['سؤال', 'أسئلة'],
  files: ['ملف', 'ملفات'],
};

/** «12 من 40 صفحة» — real counts only. */
export function progressLabelAr(p: { stage?: string; done?: number; total?: number; unit?: string | null } | null): string | null {
  if (!p) return null;
  const unit = p.unit ? (UNIT_AR[p.unit]?.[1] ?? p.unit) : '';
  if (typeof p.done === 'number' && typeof p.total === 'number' && p.total > 0) return `${p.done} من ${p.total}${unit ? ` ${unit}` : ''}`;
  if (typeof p.done === 'number') return `${p.done}${unit ? ` ${unit}` : ''} حتى الآن`;
  return null;
}

/** change_log entity types → readable names. */
export const ENTITY_LABELS_AR: Record<string, string> = {
  source: 'مصدر',
  source_version: 'نسخة مصدر',
  source_region: 'نص في صفحة',
  source_page: 'صفحة',
  library_node: 'مجلد أو دفتر',
  review_queue_item: 'عنصر مراجعة',
  content_alert: 'تنبيه تغيّر المحتوى',
  processing_job: 'مهمة خلفية',
  owner_setting: 'الإعدادات',
  settings: 'الإعدادات',
  explanation_rules: 'قواعد الشرح',
  question: 'سؤال',
  question_version: 'نسخة سؤال',
  answer_key: 'مفتاح إجابة',
  artifact: 'محتوى مولَّد',
  flashcard: 'بطاقة',
  note: 'ملاحظة',
  annotation: 'كتابة على الصفحة',
  auth_session: 'جلسة دخول',
  owner: 'الحساب',
  medical_term: 'مصطلح',
  data_backup: 'نسخة احتياطية',
  exam: 'اختبار',
  weakness: 'نقطة ضعف',
  study_plan: 'خطة دراسة',
  control: 'مركز التحكم',
  backup: 'نسخة احتياطية',
  concept: 'مفهوم',
  learning_profile: 'ملف التعلّم',
  plan_task: 'مهمة في الخطة',
  question_attempt: 'إجابة سؤال',
  question_duplicate: 'تكرار سؤال',
  question_generation_run: 'توليد أسئلة',
  question_lecture_link: 'ربط سؤال بمحاضرة',
  review_state: 'حالة مراجعة بطاقة',
  tag: 'وسم',
  topic: 'موضوع',
  topic_link: 'ربط موضوع',
  written_attempt: 'إجابة مكتوبة',
};

export const ACTION_LABELS_AR: Record<string, string> = {
  create: 'إنشاء',
  update: 'تعديل',
  move: 'نقل',
  rename: 'إعادة تسمية',
  trash: 'نقل إلى السلة',
  restore: 'استعادة',
  purge: 'حذف نهائي',
  correct: 'تصحيح',
  review: 'مراجعة',
  review_accepted: 'قبول عنصر مراجعة',
  review_corrected: 'تصحيح عنصر مراجعة',
  review_rejected: 'رفض عنصر مراجعة',
  review_dismissed: 'إغلاق عنصر مراجعة',
  accept: 'قبول',
  reject: 'رفض',
  dismiss: 'إغلاق',
  cancel: 'إلغاء',
  retry: 'إعادة محاولة',
  reprocess: 'إعادة معالجة',
  classify: 'تصنيف تلقائي',
  freeze: 'تثبيت نسخة',
  acknowledge: 'اطلاع',
  resolve: 'إغلاق',
  delete: 'حذف',
  login: 'تسجيل دخول',
  logout: 'تسجيل خروج',
  apply_change: 'تطبيق تغيير بعد معاينة الأثر',
  owner_text: 'كتابة نص صفحة',
  download: 'تنزيل',
  verify: 'تحقق',
  setup: 'إعداد الحساب',
  revoke: 'إلغاء جلسة',
  recover: 'استرداد الحساب',
  recovery_codes_regenerated: 'رموز استرداد جديدة',
  password_change: 'تغيير كلمة المرور',
  process: 'معالجة',
  link: 'ربط',
  unlink: 'إلغاء ربط',
  tag: 'وسم',
  untag: 'إزالة وسم',
  archive: 'أرشفة',
  edit: 'تعديل',
  merge: 'دمج',
  retire: 'إيقاف',
  rebuild: 'إعادة بناء',
  new_version: 'نسخة جديدة',
  correct_key: 'تصحيح مفتاح',
  owner_link: 'ربط يدوي',
  duplicate_rejected: 'رفض تكرار',
  grade: 'تقييم',
  completed: 'اكتمال',
  extract_questions: 'استخراج أسئلة',
  export_anki: 'تصدير إلى Anki',
  review_accept: 'قبول بعد المراجعة',
  mistake_type: 'تصنيف الخطأ',
  bury: 'تأجيل',
  unbury: 'إلغاء التأجيل',
  reset_signals: 'إعادة ضبط إشارات',
  rebalance: 'إعادة توزيع',
  generation_cancelled: 'إلغاء التوليد',
  create_occlusion: 'إنشاء بطاقة صورة',
  create_from_selection: 'إنشاء من تحديد',
  create_from_mistake: 'إنشاء من خطأ',
};

export const ACTOR_LABELS_AR: Record<string, string> = { owner: 'أنت', system: 'النظام', job: 'مهمة خلفية' };

export const ARTIFACT_KIND_LABELS_AR: Record<string, string> = {
  study_book: 'كتاب دراسة',
  summary: 'ملخص',
  explanation: 'شرح',
  chat_answer: 'إجابة محادثة',
  comparison: 'مقارنة',
  mind_map: 'خريطة ذهنية',
  flowchart: 'مخطط',
  figure_explanation: 'شرح شكل',
  case_explanation: 'شرح حالة',
};

export function oneLine(s: string | null | undefined, max = 160): string | null {
  if (s == null) return null;
  const t = s.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
