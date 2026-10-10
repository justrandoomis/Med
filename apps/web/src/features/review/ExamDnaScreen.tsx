// /review/dna — My Exam DNA (§40): what repeats in the owner's OWN question sources, always with the sample size, the
// files, the KNOWN date range, how repeats are counted, an explicit denominator on every row, and the warnings
// (small / old / one-file samples, unclassified items, no teacher attribution). Relevance is an importance indicator
// inside the owner's archive — never a probability that a question appears.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CircleAlert, Info } from 'lucide-react';
import { GENERATED_ITEM_TYPE_LABELS_AR, SOURCE_TYPE_LABELS_AR, type ExamDnaDetail, type SourceType } from '@medlevo/shared';
import { EmptyState, ErrorState, LoadingState, Select, buttonClass } from '../../design';
import { usePageTitle } from '../../lib/usePageTitle';
import { BidiText } from '../evidence';
import { useQuery } from '../library/data';
import { useLibrary } from '../library/useLibrary';
import { LEARNING_PATHS } from './api';
import { BarList } from './components/BarList';
import './learning.css';

// labels of the questions module's item-type estimate (questions/text.ts itemTypeOf) not covered by the generator list
const EXTRA_ITEM_TYPES_AR: Record<string, string> = { clinical_feature: 'العلامات والأعراض', investigation: 'الفحوصات', recall: 'استرجاع معلومة' };
const itemTypeLabel = (t: string) => EXTRA_ITEM_TYPES_AR[t] ?? (GENERATED_ITEM_TYPE_LABELS_AR as Record<string, string>)[t] ?? t;
const timesAr = (n: number) => (n === 1 ? 'مرة واحدة' : n === 2 ? 'مرتين' : n <= 10 ? `${n} مرات` : `${n} مرة`);
/** «سؤال واحد فريد» / «سؤالان فريدان» / «9 أسئلة فريدة» / «12 سؤالًا فريدًا» (Arabic number agreement). */
export const uniqueQuestionsAr = (n: number) =>
  n === 0 ? 'لا أسئلة' : n === 1 ? 'سؤال واحد فريد' : n === 2 ? 'سؤالان فريدان' : n <= 10 ? `${n} أسئلة فريدة` : `${n} سؤالًا فريدًا`;

export function ExamDnaScreen() {
  usePageTitle('بصمة امتحاناتك');
  const lib = useLibrary();
  const [course, setCourse] = useState('');
  const path = course ? `${LEARNING_PATHS.dna}?course_node_id=${encodeURIComponent(course)}` : LEARNING_PATHS.dna;
  const q = useQuery<ExamDnaDetail>(path, { cache: true });
  const courses = useMemo(() => (lib.data?.nodes ?? []).filter((n) => n.kind === 'course' && !n.deleted_at), [lib.data]);
  const d = q.data;

  return (
    <div className="ml-page lw-page">
      <header className="ml-page__header lw-head">
        <div>
          <h1 className="ml-page__title">
            بصمة امتحاناتك <bdi dir="ltr" lang="en" className="lw-term">Exam DNA</bdi>
          </h1>
          <p className="ml-page__lede">ما يتكرر في مصادر أسئلتك التي رفعتها فقط — مع حجم العينة وحدودها.</p>
        </div>
        {courses.length > 0 && (
          <Select label="الكورس" options={[{ value: '', label: 'كل مصادر الأسئلة' }, ...courses.map((c) => ({ value: c.id, label: c.title }))]} value={course} onValueChange={setCourse} />
        )}
      </header>

      {q.fromCache && <p className="lw-note">معروضة من آخر نسخة محفوظة على هذا الجهاز (دون اتصال)؛ قد لا تشمل آخر ما رفعته.</p>}
      {q.error && !d && <ErrorState message={q.error.message} onRetry={() => void q.refresh()} />}
      {!d && !q.error && <LoadingState stage="جارٍ تحليل مصادر أسئلتك…" />}
      {d && d.sample.files === 0 && (
        <EmptyState
          title="لا توجد مصادر أسئلة بعد"
          description="ارفع امتحانات سابقة أو بنوك أسئلة (نوع المصدر: مصدر أسئلة أو امتحان سابق). يحلّل MedLevo ملفاتك فقط، ولا يخمّن توزيع امتحانك."
          actions={
            <Link to="/library" className={buttonClass({ variant: 'primary' })}>
              المكتبة
            </Link>
          }
        />
      )}
      {d && d.sample.files > 0 && (
        <div className="lw-stack">
          <section className="lw-sheet" aria-labelledby="lw-dna-sample">
            <h2 id="lw-dna-sample" className="lw-sheet__title">
              العينة
            </h2>
            <p className="lw-dna-sample">
              {`${d.sample.files === 1 ? 'ملف واحد' : d.sample.files === 2 ? 'ملفّان' : `${d.sample.files} ملفات`}، ${uniqueQuestionsAr(d.sample.unique_questions)}، ظهرت ${timesAr(d.sample.occurrences)} إجمالًا.`}{' '}
              {d.sample.date_range ? `الفترة المعلومة: ${d.sample.date_range}.` : 'لا توجد تواريخ نشر معلومة لهذه الملفات.'}
            </p>
            <p className="lw-muted">{d.counting_note_ar}</p>
            <p className="lw-note" role="note">
              <Info size={16} aria-hidden="true" />
              <span>{d.relevance_note_ar}</span>
            </p>
            {d.warnings_ar.length > 0 && (
              <ul className="lw-warnings" aria-label="حدود هذه العينة">
                {d.warnings_ar.map((w) => (
                  <li key={w}>
                    <CircleAlert size={16} aria-hidden="true" />
                    <span>{w}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="lw-sheet">
            <BarList
              caption="المفاهيم الأكثر تكرارًا (أسئلة فريدة)"
              description={<p className="lw-muted">{`كل صف: عدد الأسئلة الفريدة عن المفهوم، والمقام هو الأسئلة الفريدة المصنّفة (${d.by_concept[0]?.denominator_unique ?? d.sample.unique_questions}). غير المصنّف: ${d.unclassified.concept}.`}</p>}
              valueHeader="أسئلة فريدة"
              data={d.by_concept.slice(0, 12).map((c, i) => ({ key: `${c.label}-${i}`, label: <BidiText as="span" text={c.label} />, labelText: c.label, value: c.unique, denominator: c.denominator_unique, note: `ظهر ${timesAr(c.occurrences)}` }))}
              emptyText="لم تُصنَّف الأسئلة إلى مفاهيم بعد."
            />
          </section>

          <div className="lw-two">
            <section className="lw-sheet">
              <BarList
                caption="أهداف الأسئلة"
                description={<p className="lw-muted">{`غير المصنّف: ${d.unclassified.item_type}.`}</p>}
                valueHeader="عدد الأسئلة"
                data={d.by_item_type.map((t) => ({ key: t.item_type, label: itemTypeLabel(t.item_type), labelText: itemTypeLabel(t.item_type), value: t.count, denominator: t.denominator }))}
                emptyText="لم تُصنَّف أهداف الأسئلة بعد."
              />
            </section>
            <section className="lw-sheet">
              <BarList
                caption="حسب المحاضرة"
                description={<p className="lw-muted">{`أسئلة لم تُربط بمحاضرة: ${d.unclassified.lecture}.`}</p>}
                valueHeader="أسئلة فريدة"
                data={d.by_lecture.map((l) => ({ key: l.lecture_source_id, label: <BidiText as="span" text={l.title} />, labelText: l.title, value: l.unique, denominator: l.denominator_unique }))}
                emptyText="لم تُربط الأسئلة بمحاضراتك بعد."
              />
            </section>
          </div>

          <section className="lw-sheet" aria-labelledby="lw-dna-files">
            <h2 id="lw-dna-files" className="lw-sheet__title">
              الملفات في العينة
            </h2>
            <div className="lw-table-wrap">
              <table className="lw-table">
                <thead>
                  <tr>
                    <th scope="col">الملف</th>
                    <th scope="col">النوع</th>
                    <th scope="col">تاريخ النشر</th>
                    <th scope="col">أسئلة فريدة</th>
                    <th scope="col">ظهور</th>
                  </tr>
                </thead>
                <tbody>
                  {d.sources.map((s) => (
                    <tr key={s.source_id}>
                      <th scope="row">
                        <BidiText as="span" text={s.title} />
                      </th>
                      <td>{SOURCE_TYPE_LABELS_AR[s.source_type as SourceType] ?? s.source_type}</td>
                      <td>{s.publication_date ?? 'غير معلوم'}</td>
                      <td>{s.unique_questions}</td>
                      <td>{s.occurrences}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="lw-muted">غياب موضوع عن هذه العينة لا يعني أنه لن يأتي في الامتحان؛ لا تُسقط دراسته بسبب هذا التحليل.</p>
          </section>
        </div>
      )}
    </div>
  );
}
