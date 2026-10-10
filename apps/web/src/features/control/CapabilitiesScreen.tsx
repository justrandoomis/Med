// القدرات (§61, §27): what works now, what does not and why — live from the server's capability registry — and a
// summary of the pen / ink capability matrix (docs/CAPABILITY_MATRIX.md), with what has NOT been tested.
import { Link } from 'react-router-dom';
import type { FeatureKey, FeatureState, FeatureStatus } from '@medlevo/shared';
import { Bidi, ErrorState, LoadingState, StatusPill, type StatusTone } from '../../design';
import { BidiText } from '../evidence/BidiText';
import { controlApi } from './api';
import { SectionHeader, useLoad } from './shared';

const FEATURE_LABELS_AR: Record<FeatureKey, string> = {
  library: 'المكتبة',
  upload: 'رفع الملفات',
  'processing.pdf': 'معالجة PDF',
  'processing.docx': 'معالجة Word (DOCX)',
  'processing.pptx': 'معالجة الشرائح (PPTX)',
  'processing.images': 'معالجة الصور',
  'processing.zip': 'ملفات ZIP للصور',
  'processing.legacy_office': 'ملفات Office القديمة (DOC/PPT)',
  'processing.ocr': 'القراءة الآلية (OCR)',
  'processing.vision': 'فهم الرسوم بالرؤية الحاسوبية',
  'workspace.reader': 'القارئ',
  'workspace.ink': 'الكتابة بالقلم',
  'workspace.handwriting_recognition': 'التعرف على خط اليد',
  'workspace.audio': 'الصوت',
  'search.keyword': 'البحث بالكلمات',
  'search.semantic': 'البحث الدلالي',
  'evidence.citations': 'الاستشهاد بالمصادر',
  'ai.explain': 'الشرح',
  'ai.chat': 'المحادثة المرتبطة بالمصدر',
  'ai.study_book': 'كتاب الدراسة',
  'ai.summaries': 'الملخصات',
  'ai.figure_explain': 'شرح الأشكال',
  'ai.generate_questions': 'توليد الأسئلة',
  'ai.grade_written': 'تقييم الإجابات المكتوبة',
  'ai.cases': 'الحالات السريرية',
  'ai.answer_check': 'التحقق من مفتاح الإجابة بأدلة المحاضرة',
  'external.evidence': 'أدلة من مصادر خارجية',
  'external.images': 'صور خارجية',
  'questions.vault': 'بنك أسئلتي',
  'questions.extraction': 'استخراج الأسئلة',
  'questions.matching': 'ربط الأسئلة بالمحاضرات',
  exams: 'الاختبارات والتدريب',
  flashcards: 'البطاقات والتكرار المتباعد',
  weakness: 'مركز نقاط الضعف',
  planner: 'خطة الدراسة',
  exam_dna: 'بصمة الامتحان',
  course_brain: 'هيكل المعرفة للكورس (دون ذكاء اصطناعي)',
  knowledge_map: 'خريطة المعرفة وخريطة معرفتي',
  coverage_map: 'خريطة تغطية الأسئلة',
  sync: 'المزامنة بين الأجهزة',
  offline: 'العمل دون اتصال',
  backup: 'النسخ الاحتياطي',
  'export.markdown': 'التصدير Markdown',
  'export.anki_tsv': 'التصدير إلى Anki',
  'export.pdf': 'التصدير PDF',
  'export.docx': 'التصدير Word',
};

const GROUPS: Array<{ title: string; prefix: (k: FeatureKey) => boolean }> = [
  { title: 'المصادر والمعالجة', prefix: (k) => k === 'library' || k === 'upload' || k.startsWith('processing.') },
  { title: 'القراءة والكتابة والبحث', prefix: (k) => k.startsWith('workspace.') || k.startsWith('search.') || k === 'evidence.citations' },
  { title: 'الذكاء الاصطناعي والمصادر الخارجية', prefix: (k) => k.startsWith('ai.') || k.startsWith('external.') },
  { title: 'الأسئلة والتعلّم', prefix: (k) => k.startsWith('questions.') || ['exams', 'flashcards', 'weakness', 'planner', 'exam_dna', 'course_brain', 'knowledge_map', 'coverage_map'].includes(k) },
  { title: 'الأجهزة والبيانات', prefix: (k) => ['sync', 'offline', 'backup'].includes(k) || k.startsWith('export.') },
];

const STATE: Record<FeatureState, { label: string; tone: StatusTone }> = {
  available: { label: 'تعمل', tone: 'success' },
  not_implemented: { label: 'لم تُبنَ بعد', tone: 'neutral' },
  requires_configuration: { label: 'تحتاج إعدادًا على الخادم', tone: 'warning' },
  requires_connection: { label: 'تحتاج اتصالًا', tone: 'info' },
  requires_native: { label: 'تحتاج تطبيقًا أصليًا', tone: 'neutral' },
  disabled_by_owner: { label: 'أوقفتها بنفسك', tone: 'neutral' },
};

const PEN_SUMMARY = [
  'لم يُختبر أي قلم حقيقي (Apple Pencil أو غيره) على أي جهاز؛ ما اختُبر آليًا كان بالفأرة في Chromium وبمحاكاة في jsdom.',
  // never «تعمل»: these paths ran only with simulated events (G6 / AC-28)
  'الضغط والميل والتمرير فوق الشاشة مبنية وتُستخدم حين يرسلها المتصفح فعلًا؛ لم تُشغَّل إلا بأحداث محاكاة، ولم تُختبر على جهاز حقيقي.',
  'رفض راحة اليد على الويب تقريبي (وضع القلم فقط، وتجاهل اللمسات الواسعة)؛ رفض النظام الحقيقي يحتاج طبقة iPad أصلية.',
  'النقر المزدوج والضغط على Apple Pencil والكتابة اليدوية Scribble على اللوحة غير متاحة على الويب.',
  'الكتابة دون اتصال (التخزين المحلي ثم المزامنة) ودقة موضع الحبر عبر التكبير والتدوير اختُبرت آليًا بالفأرة في Chromium.',
];

export function Row({ f }: { f: FeatureStatus }) {
  const s = STATE[f.state];
  // a working feature may still carry a limit the server states (audio without transcription, figures without
  // vision, PDF only through browser printing): never hide it behind a bare «تعمل» (§61, critic round)
  const limited = f.state === 'available' && !!f.reason_ar;
  return (
    <li className="cc-cap">
      <span className="cc-cap__name">{FEATURE_LABELS_AR[f.key] ?? f.key}</span>
      <StatusPill tone={s.tone}>{limited ? 'تعمل بحدود' : s.label}</StatusPill>
      {f.reason_ar && <BidiText as="span" dir="rtl" className="cc-cap__why" text={limited ? `الحدود: ${f.reason_ar}` : f.reason_ar} />}
    </li>
  );
}

export function CapabilitiesScreen() {
  const caps = useLoad(() => controlApi.capabilities(), [], 'قائمة القدرات تُقرأ من الخادم؛ لا يوجد اتصال الآن.');
  const d = caps.data;
  return (
    <div className="cc-section">
      <SectionHeader title="القدرات" lede="ما يعمل الآن على هذا الخادم وما لا يعمل، مع السبب المحدد. لا تُعرض ميزة كأنها تعمل وهي لا تعمل." />
      {caps.error ? (
        <ErrorState inline message={caps.error} onRetry={caps.reload} />
      ) : !d ? (
        <LoadingState inline stage="جارٍ تحميل القدرات…" />
      ) : (
        <>
          <p className="cc-muted">
            إصدار الخادم <Bidi dir="ltr">{d.app_version}</Bidi>. الذكاء الاصطناعي: {d.ai.configured ? <Bidi dir="ltr">{d.ai.provider ?? 'مهيأ'}</Bidi> : 'غير مهيأ'}.
          </p>
          {GROUPS.map((g) => {
            const list = (Object.values(d.features) as FeatureStatus[]).filter((f) => g.prefix(f.key));
            if (!list.length) return null;
            return (
              <section key={g.title} className="cc-block" aria-label={g.title}>
                <h2 className="cc-block__title">{g.title}</h2>
                <ul role="list" className="cc-caps">
                  {list.map((f) => (
                    <Row key={f.key} f={f} />
                  ))}
                </ul>
              </section>
            );
          })}
        </>
      )}
      <section className="cc-block" aria-labelledby="cc-pen-h">
        <h2 id="cc-pen-h" className="cc-block__title">
          القلم والكتابة (ملخص مصفوفة القدرات)
        </h2>
        <ul className="cc-bullets">
          {PEN_SUMMARY.map((x, i) => (
            <li key={i}>
              <BidiText as="span" dir="rtl" text={x} />
            </li>
          ))}
        </ul>
        <p className="cc-muted">
          الجدول الكامل في <Bidi dir="ltr">docs/CAPABILITY_MATRIX.md</Bidi>. لمعرفة ما يرسله متصفحك فعلًا، افتح أي مصدر ثم «المزيد من أدوات الكتابة» ← «قدرات القلم على هذا الجهاز». <Link to="/library">افتح المكتبة</Link>
        </p>
      </section>
    </div>
  );
}
