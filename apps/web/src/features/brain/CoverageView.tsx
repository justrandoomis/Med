// Question Coverage Map (§36): which pages and concepts have SOURCE questions, which only have GENERATED questions
// (kept separate), which you have attempted, and which have none — every count with its denominator, every status in
// words + icon (never colour alone), a table for each list.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CircleDashed, CircleDot, FileCheck2, Sparkles } from 'lucide-react';
import { COVERAGE_STATUS_LABELS_AR, type CoverageLecture, type CoverageResponse, type CoverageStatus } from '@medlevo/shared';
import { EmptyState, ErrorState, LoadingState, Select, StatusPill, type StatusTone } from '../../design';
import { useQuery } from '../library/data';
import { BarList } from '../review/components/BarList';
import { BRAIN_PATHS, conceptUrl } from './api';
import { countAr, coverageLines, NOUNS } from './model';

const STATUS_META: Record<CoverageStatus, { tone: StatusTone; icon: React.ReactNode }> = {
  source: { tone: 'success', icon: <FileCheck2 size={14} /> },
  generated_only: { tone: 'info', icon: <Sparkles size={14} /> },
  uncovered: { tone: 'neutral', icon: <CircleDashed size={14} /> },
};

export function CoverageStatusPill({ status }: { status: CoverageStatus }) {
  const m = STATUS_META[status];
  return (
    <StatusPill tone={m.tone} icon={m.icon}>
      {COVERAGE_STATUS_LABELS_AR[status]}
    </StatusPill>
  );
}

export function CoverageView({ courseNodeId }: { courseNodeId: string }) {
  const q = useQuery<CoverageResponse>(BRAIN_PATHS.coverage({ courseNodeId }), { cache: true });
  const [lectureId, setLectureId] = useState<string>('all');
  if (q.loading && !q.data) return <LoadingState stage="جارٍ حساب تغطية الأسئلة…" />;
  if (q.error && !q.data) return <ErrorState message={q.error.message} onRetry={() => void q.refresh()} />;
  const data = q.data!;
  if (data.lectures.length === 0) return <EmptyState headingLevel={3} title="لا محاضرات في هذا الكورس بعد" description="بعد رفع المحاضرات ومصادر الأسئلة يظهر هنا ما له أسئلة وما بلا أسئلة." />;
  const shown = lectureId === 'all' ? data.lectures : data.lectures.filter((l) => l.source_id === lectureId);
  const totals = lectureId === 'all' ? data.totals : { pages: shown[0]!.totals.pages, concepts: shown[0]!.totals.concepts };
  return (
    <div className="lw-stack">
      {q.fromCache && <p className="lw-note">معروضة من آخر نسخة محفوظة على هذا الجهاز (دون اتصال).</p>}
      <div className="kb-filter-row">
        <Select<string>
          label="المحاضرة"
          options={[{ value: 'all', label: 'كل محاضرات الكورس' }, ...data.lectures.map((l) => ({ value: l.source_id, label: l.title }))]}
          value={lectureId}
          onValueChange={setLectureId}
        />
      </div>
      <section className="lw-sheet" aria-labelledby="cv-totals">
        <h3 id="cv-totals" className="lw-sheet__title">
          الخلاصة
        </h3>
        <BarList caption={`الصفحات (المقام: ${countAr(totals.pages.total, NOUNS.page)})`} valueHeader="عدد الصفحات" data={coverageLines(totals.pages, { plural: 'صفحات' }).map((l) => ({ key: `p-${l.key}`, label: l.label, labelText: l.label, value: l.value, denominator: l.denominator }))} />
        <BarList
          caption={`المفاهيم غير المرفوضة (المقام: ${countAr(totals.concepts.total, NOUNS.concept)})`}
          valueHeader="عدد المفاهيم"
          data={coverageLines(totals.concepts, { plural: 'مفاهيم' }).map((l) => ({ key: `c-${l.key}`, label: l.label, labelText: l.label, value: l.value, denominator: l.denominator }))}
        />
      </section>
      {shown.map((l) => (
        <LectureCoverage key={l.source_id} lecture={l} />
      ))}
      <ul className="kb-notes">
        {data.notes_ar.map((n) => (
          <li key={n} className="lw-muted">
            {n}
          </li>
        ))}
      </ul>
    </div>
  );
}

function LectureCoverage({ lecture }: { lecture: CoverageLecture }) {
  const [showAll, setShowAll] = useState(false);
  const t = lecture.totals;
  const concepts = showAll ? lecture.concepts : lecture.concepts.slice(0, 25);
  return (
    <section className="lw-sheet" aria-labelledby={`cv-${lecture.source_id}`}>
      <h3 id={`cv-${lecture.source_id}`} className="lw-sheet__title">
        <bdi>{lecture.title}</bdi>
      </h3>
      <p className="lw-muted">
        أسئلة من المصادر: {t.questions.source} (حاولت {t.questions.attempted_source}) · أسئلة مولدة: {t.questions.generated} (حاولت {t.questions.attempted_generated})
      </p>
      <h4 className="lw-sheet__subtitle">الصفحات</h4>
      {lecture.pages.length === 0 ? (
        <p className="lw-muted">لا صفحات معالجة لهذه المحاضرة بعد.</p>
      ) : (
        <ul className="kb-pages-grid" aria-label={`صفحات «${lecture.title}» وتغطيتها`}>
          {lecture.pages.map((p) => (
            <li key={p.page_id} className="kb-page-cell" data-status={p.status}>
              <Link className="kb-page-cell__label" to={`/study/${encodeURIComponent(lecture.source_id)}?page_id=${encodeURIComponent(p.page_id)}`}>
                {p.label_ar}
              </Link>
              <CoverageStatusPill status={p.status} />
              <span className="lw-muted">
                مصادر {p.source_question_ids.length} · مولدة {p.generated_question_ids.length} · حاولت {p.attempted_question_ids.length}
              </span>
            </li>
          ))}
        </ul>
      )}
      <h4 className="lw-sheet__subtitle">المفاهيم</h4>
      {lecture.concepts.length === 0 ? (
        <p className="lw-muted">لا مفاهيم مستخرجة لهذه المحاضرة بعد.</p>
      ) : (
        <div className="lw-table-wrap">
          <table className="lw-table">
            <caption className="ml-visually-hidden">مفاهيم «{lecture.title}» وتغطيتها بالأسئلة</caption>
            <thead>
              <tr>
                <th scope="col">المفهوم</th>
                <th scope="col">التغطية</th>
                <th scope="col">أسئلة المصادر</th>
                <th scope="col">أسئلة مولدة</th>
                <th scope="col">حاولت منها</th>
              </tr>
            </thead>
            <tbody>
              {concepts.map((c) => (
                <tr key={c.concept_id}>
                  <th scope="row">
                    <Link className="lw-link" to={conceptUrl(c.concept_id)}>
                      <bdi>{c.name}</bdi>
                    </Link>
                    {c.status_concept === 'suggested' && (
                      <span className="lw-muted kb-cell-note">
                        <CircleDot size={12} aria-hidden="true" /> مقترح
                      </span>
                    )}
                  </th>
                  <td>
                    <CoverageStatusPill status={c.status} />
                    <span className="lw-muted kb-cell-note">{c.basis_ar}</span>
                  </td>
                  <td>{c.source_question_ids.length}</td>
                  <td>{c.generated_question_ids.length}</td>
                  <td>{c.attempted_question_ids.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {lecture.concepts.length > 25 && (
        <button type="button" className="lw-link kb-linkbtn" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
          {showAll ? 'اعرض أقل' : `اعرض كل المفاهيم (${lecture.concepts.length})`}
        </button>
      )}
    </section>
  );
}
