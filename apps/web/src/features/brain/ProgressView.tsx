// Course progress (§23 course page, §45): four DIFFERENT numbers per lecture, never conflated into one score —
// reading (pages shown in the reader ÷ pages), explanation coverage (Study Book sections ÷ sections), practice
// (attempts and card reviews — a count, no denominator, so no bar) and the mastery ESTIMATE (null below its sample).
import type { SourceProgressListResponse } from '@medlevo/shared';
import { EmptyState, ErrorState, LoadingState } from '../../design';
import { useQuery } from '../library/data';
import { BarList } from '../review/components/BarList';
import { BRAIN_PATHS } from './api';
import { masteryText } from './model';

export function ProgressView({ courseNodeId }: { courseNodeId: string }) {
  const q = useQuery<SourceProgressListResponse>(BRAIN_PATHS.progress(courseNodeId), { cache: true });
  if (q.loading && !q.data) return <LoadingState stage="جارٍ حساب التقدم…" />;
  if (q.error && !q.data) return <ErrorState message={q.error.message} onRetry={() => void q.refresh()} />;
  const items = q.data?.items ?? [];
  if (items.length === 0) return <EmptyState headingLevel={3} title="لا محاضرات في هذا الكورس بعد" description="ارفع محاضرات الكورس ليظهر تقدمك فيها: القراءة والشرح والتدريب والإتقان التقديري، كلٌّ على حدة." />;
  return (
    <div className="lw-stack">
      {q.fromCache && <p className="lw-note">معروضة من آخر نسخة محفوظة على هذا الجهاز (دون اتصال).</p>}
      <p className="lw-note" role="note">
        <span>{items[0]!.notes_ar[0]}</span>
      </p>
      <section className="lw-sheet" aria-labelledby="pv-read">
        <h3 id="pv-read" className="lw-sheet__title">
          القراءة
        </h3>
        <BarList
          caption="الصفحات التي عُرضت في القارئ من صفحات كل محاضرة"
          valueHeader="صفحات عُرضت"
          data={items.map((i) => ({
            key: i.source_id,
            label: <bdi>{i.title}</bdi>,
            labelText: i.title,
            value: i.reading.pages_viewed,
            denominator: i.reading.pages_total ?? 0,
          }))}
          valueText={(d) => (d.denominator ? `${d.value} من ${d.denominator} صفحة` : 'لم تُفتح بعد')}
        />
      </section>
      <section className="lw-sheet" aria-labelledby="pv-exp">
        <h3 id="pv-exp" className="lw-sheet__title">
          تغطية الشرح (كتاب الدراسة)
        </h3>
        <BarList
          caption="أقسام كتاب الدراسة المكتملة من أقسامه"
          valueHeader="أقسام مكتملة"
          data={items.map((i) => ({
            key: i.source_id,
            label: <bdi>{i.title}</bdi>,
            labelText: i.title,
            value: i.explanation.sections_covered,
            denominator: i.explanation.sections_total,
            note: i.explanation.artifact_id ? null : 'لا كتاب دراسة لهذه المحاضرة بعد',
          }))}
          valueText={(d) => (d.denominator ? `${d.value} من ${d.denominator} قسم` : 'لا أقسام')}
        />
      </section>
      <section className="lw-sheet" aria-labelledby="pv-practice">
        <h3 id="pv-practice" className="lw-sheet__title">
          التدريب والإتقان التقديري
        </h3>
        <div className="lw-table-wrap">
          <table className="lw-table">
            <caption className="ml-visually-hidden">التدريب والإتقان التقديري لكل محاضرة</caption>
            <thead>
              <tr>
                <th scope="col">المحاضرة</th>
                <th scope="col">محاولات أسئلة (محسوبة)</th>
                <th scope="col">مراجعات بطاقات</th>
                <th scope="col">الإتقان (تقدير)</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.source_id}>
                  <th scope="row">
                    <bdi>{i.title}</bdi>
                  </th>
                  <td>
                    {i.practice.question_attempts} ({i.practice.scored_attempts})
                  </td>
                  <td>{i.practice.card_reviews}</td>
                  <td>
                    {masteryText(i.mastery_estimate, i.mastery.sample)}
                    <span className="lw-muted kb-cell-note">{i.mastery.basis_ar}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <ul className="kb-notes">
        {items[0]!.notes_ar.slice(1).map((n) => (
          <li key={n} className="lw-muted">
            {n}
          </li>
        ))}
      </ul>
    </div>
  );
}
