// «المحاضرة» tab of a source (Academic OS P1-T3, PRD AOS-3.3…3.5, 3.9, 3.18): the lecture number and session date with
// where each came from, the import suggestions waiting for the owner (nothing is applied without «أكّد»), the printed
// contents page as links into the reader, and the way to order the folder's lectures by number or date.
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ListOrdered, RefreshCw } from 'lucide-react';
import { TOC_RESOLUTION_LABELS_AR, type LectureIdentityView, type PrintedTocView, type SourceDetail, type SourceIdentityResponse } from '@medlevo/shared';
import { Button, buttonClass, ErrorState, LoadingState, StatusPill, TextField, useToast } from '../../design';
import { api, errorMessage, fieldErrors } from '../../lib/api';
import { invalidate, useQuery } from '../library/data';
import { SuggestionCard } from './SuggestionCard';
import { ORIGIN_LABEL_AR, studyHref } from './versionsModel';

export function IdentityPanel({ detail, readOnly }: { detail: SourceDetail; readOnly: boolean }) {
  const q = useQuery<SourceIdentityResponse>(`/versions/sources/${encodeURIComponent(detail.id)}/identity`);
  const studied = detail.frozen_version_id ?? detail.current_version_id;
  const toc = useQuery<PrintedTocView>(studied && detail.format !== 'audio' ? `/versions/versions/${encodeURIComponent(studied)}/toc` : null);
  const toast = useToast();
  const [running, setRunning] = useState(false);

  if (q.loading && !q.data) return <LoadingState stage="جارٍ تحميل بيانات المحاضرة…" />;
  if (q.error && !q.data) return <ErrorState message={q.error.message} onRetry={() => void q.refresh()} />;
  const d = q.data!;
  const open = d.suggestions.filter((s) => s.status === 'open' || s.status === 'applied');
  const past = d.suggestions.filter((s) => s.status === 'accepted' || s.status === 'rejected');
  const analyze = async () => {
    setRunning(true);
    try {
      await api.post(`/versions/sources/${encodeURIComponent(detail.id)}/analyze`);
      toast.show({ title: 'بدأ تحليل الملف؛ تظهر الاقتراحات هنا عند انتهائه.', tone: 'info' });
      await q.refresh();
    } catch (e) {
      toast.show({ title: errorMessage(e), tone: 'danger' });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="ml-stack">
      <IdentityForm key={`${d.identity.lecture_no ?? ''}|${d.identity.held_on ?? ''}`} identity={d.identity} readOnly={readOnly} onSaved={() => void q.refresh()} />

      <section className="ml-stack" aria-labelledby="sugg-title">
        <div className="ml-library__section-head">
          <h2 id="sugg-title" className="ml-library__section-title">
            اقتراحات من الملف ({open.length})
          </h2>
          {d.analysis && (
            <span className="ml-library__section-note" role="status">
              {d.analysis.state === 'pending' ? 'يجري تحليل الملف…' : d.analysis.state === 'ready' ? 'حُلّل الملف.' : (d.analysis.reason_ar ?? '')}
            </span>
          )}
        </div>
        <p className="ml-trash-note">تُقرأ هذه الاقتراحات من اسم الملف وصفحاته الأولى داخل مكتبتك فقط. لا يتغير شيء قبل أن تؤكده، وما ترفضه لا يُقترح مجددًا.</p>
        {open.length === 0 ? (
          <p className="ml-row__sub">لا اقتراحات بانتظارك لهذا الملف.</p>
        ) : (
          <ul className="ml-list" role="list">
            {open.map((s) => (
              <SuggestionCard key={s.id} suggestion={s} readOnly={readOnly} onDecided={() => void q.refresh()} />
            ))}
          </ul>
        )}
        {!readOnly && d.analysis && (d.analysis.state === 'not_run' || d.analysis.state === 'failed') && (
          <div>
            <Button size="sm" icon={<RefreshCw size={16} />} onClick={() => void analyze()} loading={running} loadingLabel="جارٍ الطلب…">
              حلّل هذا الملف الآن
            </Button>
          </div>
        )}
        {past.length > 0 && (
          <details className="ml-upload__entries">
            <summary>قرارات سابقة ({past.length})</summary>
            <ul className="ml-list" role="list">
              {past.map((s) => (
                <SuggestionCard key={s.id} suggestion={s} readOnly />
              ))}
            </ul>
          </details>
        )}
      </section>

      {toc.data && toc.data.entries.length > 0 && studied && <PrintedToc toc={toc.data} sourceId={detail.id} versionId={studied} />}

      {detail.node_id && (
        <div>
          <Link to={`/lectures/order/${encodeURIComponent(detail.node_id)}`} className={buttonClass({ variant: 'secondary', size: 'sm' })}>
            <ListOrdered size={16} aria-hidden="true" />
            رتّب محاضرات هذا المجلد حسب الرقم أو التاريخ
          </Link>
        </div>
      )}
    </div>
  );
}

function IdentityForm({ identity, readOnly, onSaved }: { identity: LectureIdentityView; readOnly: boolean; onSaved: () => void }) {
  const toast = useToast();
  const [no, setNo] = useState(identity.lecture_no === null ? '' : String(identity.lecture_no));
  const [date, setDate] = useState(identity.held_on ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const noChanged = no !== (identity.lecture_no === null ? '' : String(identity.lecture_no));
  const dateChanged = date !== (identity.held_on ?? '');
  const changed = noChanged || dateChanged;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    // an Arabic keyboard types ٠–٩ (or ۰–۹): read them as the same digits
    const trimmed = no.trim().replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
    if (trimmed && !/^\d{1,3}$/.test(trimmed)) {
      setErrors({ lecture_no: 'اكتب رقمًا من 1 إلى 999.' });
      return;
    }
    setSaving(true);
    setErrors({});
    try {
      // (review) only what the owner changed: saving the number must not also decide «no date» (that answers an open
      // date suggestion and stops date detection for this lecture)
      await api.patch(`/versions/sources/${encodeURIComponent(identity.source_id)}/identity`, {
        ...(noChanged ? { lecture_no: trimmed ? Number(trimmed) : null } : {}),
        ...(dateChanged ? { held_on: date || null } : {}),
      });
      toast.show({ title: 'حُفظ رقم المحاضرة وتاريخها كقرار منك.', tone: 'success' });
      invalidate('/versions');
      onSaved();
    } catch (err) {
      const f = fieldErrors(err);
      setErrors(Object.keys(f).length ? f : { form: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <form className="ml-group" onSubmit={(e) => void submit(e)} aria-labelledby="identity-title">
      <div className="ml-group__row ml-group__row--stack">
        <h2 id="identity-title" className="ml-field__label">
          رقم المحاضرة وتاريخها
        </h2>
        <div className="ml-cluster">
          {identity.lecture_no_origin && <StatusPill tone={identity.lecture_no_origin === 'detected' ? 'info' : 'success'}>الرقم: {ORIGIN_LABEL_AR[identity.lecture_no_origin]}</StatusPill>}
          {identity.held_on_origin && <StatusPill tone={identity.held_on_origin === 'detected' ? 'info' : 'success'}>التاريخ: {ORIGIN_LABEL_AR[identity.held_on_origin]}</StatusPill>}
        </div>
        {identity.original_file_name && (
          <p className="ml-row__sub">
            اسم الملف الأصلي: <bdi>{identity.original_file_name}</bdi>
          </p>
        )}
        <div className="ml-identity__fields">
          <TextField label="رقم المحاضرة" inputMode="numeric" value={no} onChange={(e) => setNo(e.target.value)} disabled={readOnly} error={errors.lecture_no} hint="اتركه فارغًا إن لم يكن لها رقم." dir="ltr" />
          <TextField label="تاريخ المحاضرة" type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={readOnly} error={errors.held_on} dir="ltr" />
        </div>
        {errors.form && (
          <p className="ml-field__error" role="alert">
            {errors.form}
          </p>
        )}
        {!readOnly && (
          <div>
            <Button type="submit" variant="primary" size="sm" disabled={!changed} loading={saving} loadingLabel="جارٍ الحفظ…">
              احفظ
            </Button>
          </div>
        )}
      </div>
    </form>
  );
}

function PrintedToc({ toc, sourceId, versionId }: { toc: PrintedTocView; sourceId: string; versionId: string }) {
  return (
    <section className="ml-group" aria-labelledby="toc-title">
      <div className="ml-group__row ml-group__row--stack">
        <h2 id="toc-title" className="ml-field__label">
          الفهرس المطبوع في الملف
        </h2>
        <p className="ml-field__hint">قُرئت صفحة الفهرس وربط كل عنوان بصفحته. الربط التقديري معلَّم بذلك.</p>
        <ol className="ml-toc" role="list">
          {toc.entries.map((e, i) => (
            <li key={`${e.title}-${i}`} className="ml-toc__row">
              {e.target ? (
                <Link to={studyHref(sourceId, versionId, e.target.page_index)} className="ml-toc__link">
                  <bdi>{e.title}</bdi>
                  <span className="ml-toc__page">{e.target.label_ar}</span>
                </Link>
              ) : (
                <span className="ml-toc__link ml-toc__link--none">
                  <bdi>{e.title}</bdi>
                  <span className="ml-toc__page">ص {e.printed_page}</span>
                </span>
              )}
              {e.resolution !== 'printed_label' && <span className="ml-row__sub">{TOC_RESOLUTION_LABELS_AR[e.resolution]}</span>}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
