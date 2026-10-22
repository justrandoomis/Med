// «الملفات المكررة» — identical and near-duplicate files of one subject (IA §4.10; PRD AOS-18.11; Subject Moderator,
// Admin, platform admin). Only the subject's own space is compared, so the screen names nothing outside it. Identical
// means the same bytes; near means most pages share their text (page fingerprints, P1-T3). The coverage line says how
// many versions were compared and how many have page fingerprints yet, so an empty list is never a silent «no duplicates».
import { useCallback, useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import { DUPLICATE_NEAR_THRESHOLD, OFFICIAL_LECTURE_STATUS_LABELS_AR, type SubjectDuplicateGroup, type SubjectDuplicatesResponse } from '@medlevo/shared';
import { EmptyState, ErrorState, LoadingState, StatusPill } from '../../../design';
import { errorMessage } from '../../../lib/api';
import { BidiText } from '../../evidence/BidiText';
import { type AdminSubject, lecturesApi } from '../api';
import { SubjectScope } from './SubjectScope';
import { useAdminSubjects } from './useAdminSubjects';
import './lectures-admin.css';

const ATTACHMENT_STATUS_AR: Record<string, string> = { draft: 'مسودة', published: 'منشور', withdrawn: 'مسحوب' };

function statusLabel(item: SubjectDuplicateGroup['items'][number]): string {
  if (item.type === 'lecture') return (OFFICIAL_LECTURE_STATUS_LABELS_AR as Record<string, string>)[item.status] ?? item.status;
  return ATTACHMENT_STATUS_AR[item.status] ?? item.status;
}

function percent(x: number): string {
  return `${Math.round(x * 100)}٪`;
}

function Group({ g, index }: { g: SubjectDuplicateGroup; index: number }) {
  const headingId = `dup-${index}`;
  return (
    <li className="lec-admin__row" aria-labelledby={headingId}>
      <div className="lec-admin__row-head">
        <StatusPill tone={g.kind === 'identical' ? 'warning' : 'info'}>{g.kind === 'identical' ? 'متطابقة' : `متشابهة ${percent(g.similarity)}`}</StatusPill>
        <span id={headingId} className="lec-admin__title">
          {g.items.length} ملفات
        </span>
      </div>
      <p className="lec-admin__meta">{g.basis_ar}</p>
      <ul className="lec-admin__dup-files">
        {g.items.map((it) => (
          <li key={`${it.type}:${it.id}:${it.version.id}`} className="lec-admin__dup-file">
            <BidiText as="span" className="lec-admin__title" text={it.title} />
            <span className="lec-admin__meta">
              {it.type === 'lecture' ? 'محاضرة رسمية' : 'مرفق'} · الإصدار {it.version.version_no} · {statusLabel(it)}
              {it.version.page_count !== null ? ` · ${it.version.page_count} صفحة` : ''}
            </span>
            {it.version.file_name && <BidiText as="span" className="lec-admin__meta" text={it.version.file_name} />}
          </li>
        ))}
      </ul>
    </li>
  );
}

function SubjectDuplicates({ subject }: { subject: AdminSubject }) {
  const [data, setData] = useState<SubjectDuplicatesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => {
    setError(null);
    setData(null);
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    let alive = true;
    lecturesApi
      .duplicates(subject.spaceId)
      .then((d) => alive && setData(d))
      .catch((e: unknown) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [subject.spaceId, nonce]);

  if (error) return <ErrorState message={error} onRetry={reload} inline />;
  if (!data) return <LoadingState stage="جارٍ مقارنة ملفات المادة…" inline />;
  const identical = data.groups.filter((g) => g.kind === 'identical');
  const near = data.groups.filter((g) => g.kind === 'near');
  const pending = data.checked.versions - data.checked.fingerprinted;
  return (
    <>
      <p className="lec-admin__note lec-admin__coverage">
        قورن {data.checked.versions} ملفًا في هذه المادة فقط
        {pending > 0 ? `؛ ${pending} منها لم تكتمل بصمات صفحاتها بعد فلا تدخل في كشف التشابه.` : '.'}
      </p>
      {data.groups.length === 0 ? (
        <EmptyState icon={<Copy size={28} aria-hidden="true" />} headingLevel={2} title="لا توجد ملفات مكررة" description="لم نجد ملفين متطابقين ولا متشابهين في محاضرات المادة ومرفقاتها." />
      ) : (
        <>
          <section aria-labelledby="dup-identical" className="lec-admin__group">
            <h2 id="dup-identical" className="lec-admin__h2">
              ملفات متطابقة
            </h2>
            {identical.length ? (
              <ul className="lec-admin__list">
                {identical.map((g, i) => (
                  <Group key={`i${i}`} g={g} index={i} />
                ))}
              </ul>
            ) : (
              <p className="lec-admin__empty">لا توجد ملفات متطابقة البايتات.</p>
            )}
          </section>
          <section aria-labelledby="dup-near" className="lec-admin__group">
            <h2 id="dup-near" className="lec-admin__h2">
              ملفات متشابهة
            </h2>
            <p className="lec-admin__note">تُعد ملفات متشابهة إذا تطابق نص {percent(DUPLICATE_NEAR_THRESHOLD)} من صفحاتها على الأقل.</p>
            {near.length ? (
              <ul className="lec-admin__list">
                {near.map((g, i) => (
                  <Group key={`n${i}`} g={g} index={identical.length + i} />
                ))}
              </ul>
            ) : (
              <p className="lec-admin__empty">لا توجد ملفات متشابهة.</p>
            )}
          </section>
        </>
      )}
    </>
  );
}

export function DuplicatesSection() {
  // only subjects where the viewer moderates official content (Subject Moderator, Admin or the platform admin)
  const subjects = useAdminSubjects(['subject_moderator', 'admin']);
  return (
    <div className="lec-admin" dir="rtl">
      <h1 className="lec-admin__h1">الملفات المكررة</h1>
      <SubjectScope state={subjects}>{(s) => <SubjectDuplicates key={s.spaceId} subject={s} />}</SubjectScope>
    </div>
  );
}

export const Component = DuplicatesSection;
