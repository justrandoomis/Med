// المعالجة (§48 Processing, §53, AC-03): what runs now with its real stage and counts, what failed and why in
// words, what retry / cancel do before they are done, and every source version whose coverage is incomplete —
// page by page, with re-processing of exactly those pages. Never a raw log.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CircleStop, RotateCcw, Wrench } from 'lucide-react';
import type { ControlJobView, VersionAttentionView } from '@medlevo/shared';
import { Button, ConfirmDialog, EmptyState, ErrorState, LoadingState, ProgressBar, StatusPill, type StatusTone, buttonClass } from '../../design';
import { errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/time';
import { BidiText } from '../evidence/BidiText';
import { controlApi } from './api';
import { SectionHeader, useControlContext, useLoad } from './shared';

const STATUS_TONE: Record<string, StatusTone> = {
  queued: 'neutral',
  running: 'info',
  waiting_for_input: 'warning',
  partial: 'warning',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

function JobRow({ j, onChanged }: { j: ControlJobView; onChanged: () => void }) {
  const [confirm, setConfirm] = useState<'retry' | 'cancel' | null>(null);
  const p = j.progress;
  const hasTotal = typeof p?.total === 'number' && p.total > 0 && typeof p.done === 'number';
  return (
    <li className="cc-job">
      <div className="cc-job__head">
        <StatusPill tone={STATUS_TONE[j.status] ?? 'neutral'}>{j.status_label_ar}</StatusPill>
        <span className="cc-job__kind">{j.kind_label_ar}</span>
        {j.source && <BidiText as="span" dir="rtl" className="cc-job__source" text={j.source.title + (j.source.version_no ? ` — النسخة ${j.source.version_no}` : '')} />}
      </div>
      <p className="cc-job__explain">{j.explanation_ar}</p>
      {j.status === 'running' && p && (
        <div className="cc-job__progress">
          <p className="cc-muted">
            {p.stage}
            {j.progress_label_ar ? ` — ${j.progress_label_ar}` : ''}
          </p>
          {hasTotal && <ProgressBar label={`${j.kind_label_ar}: ${p.stage}`} value={p.done} max={p.total} valueText={j.progress_label_ar ?? undefined} />}
        </div>
      )}
      {j.error && (
        <p className="cc-job__error">
          <span className="cc-label">السبب: </span>
          <BidiText as="span" dir="rtl" text={j.error.message} />
        </p>
      )}
      <p className="cc-job__meta">
        {j.finished_at ? `انتهت ${formatDateTime(j.finished_at)}` : j.started_at ? `بدأت ${formatDateTime(j.started_at)}` : `أُضيفت ${formatDateTime(j.created_at)}`}
        {j.attempts > 1 ? `، المحاولات: ${j.attempts} من ${j.max_attempts}` : ''}
      </p>
      {(j.can_retry || j.can_cancel) && (
        <div className="cc-job__actions">
          {j.can_retry && (
            <Button size="sm" variant="secondary" icon={<RotateCcw size={14} />} onClick={() => setConfirm('retry')}>
              أعد المحاولة
            </Button>
          )}
          {j.can_cancel && (
            <Button size="sm" variant="plain" icon={<CircleStop size={14} />} onClick={() => setConfirm('cancel')}>
              ألغِ المهمة
            </Button>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirm === 'retry'}
        title="إعادة محاولة المهمة"
        impact={j.retry_effect_ar ?? ''}
        confirmLabel="أعد المحاولة"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          await controlApi.retryJob(j.id);
          setConfirm(null);
          onChanged();
        }}
      />
      <ConfirmDialog
        open={confirm === 'cancel'}
        title="إلغاء المهمة"
        impact={j.cancel_effect_ar ?? ''}
        confirmLabel="ألغِ المهمة"
        cancelLabel="رجوع"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          await controlApi.cancelJob(j.id);
          setConfirm(null);
          onChanged();
        }}
      />
    </li>
  );
}

function VersionCard({ v, onChanged }: { v: VersionAttentionView; onChanged: () => void }) {
  const [busy, setBusy] = useState<number | 'all' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reprocessable = v.pages.filter((p) => !p.owner_corrected);
  const run = async (indexes: number[], key: number | 'all') => {
    setBusy(key);
    setError(null);
    try {
      await controlApi.reprocessPages(v.version_id, indexes);
      setMessage(indexes.length === 1 ? 'أُضيفت إعادة معالجة الصفحة إلى المهام.' : `أُضيفت إعادة معالجة ${indexes.length} صفحات إلى المهام.`);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const s = v.summary;
  return (
    <li className="cc-version">
      <div className="cc-version__head">
        <StatusPill tone={v.processing_status === 'failed' ? 'danger' : 'warning'}>{v.status_label_ar}</StatusPill>
        <Link to={`/sources/${encodeURIComponent(v.source_id)}`} className="cc-version__title">
          <BidiText as="span" dir="rtl" text={v.source_title} />
        </Link>
        <span className="cc-muted">النسخة {v.version_no}{v.is_active ? '' : ' (ليست المستخدمة للدراسة)'}</span>
      </div>
      {s && (
        <p className="cc-version__counts">
          {s.pages_total !== null ? `${s.pages_ready} جاهزة من ${s.pages_total}` : `${s.pages_ready} جاهزة`}
          {s.pages_needs_review ? `، و${s.pages_needs_review} تحتاج مراجعتك` : ''}
          {s.pages_failed ? `، و${s.pages_failed} متعثرة` : ''}
        </p>
      )}
      <p className="cc-version__note">{v.coverage_note_ar}</p>
      {v.pages.length > 0 && (
        <ul className="cc-pages" aria-label={`صفحات ${v.source_title} التي تحتاج انتباهك`}>
          {v.pages.map((p) => (
            <li key={`${p.page_index}`} className="cc-pages__row">
              <div className="cc-pages__text">
                <span className="cc-pages__label">{p.label_ar}</span>
                <BidiText as="span" dir="rtl" className="cc-pages__reason" text={p.reason_ar} />
                {p.owner_corrected && <span className="cc-muted">فيها نص صحّحته أو كتبته بنفسك، فلا تُعاد معالجتها حتى لا يُستبدل نصك.</span>}
              </div>
              {!p.owner_corrected && (
                <Button size="sm" variant="plain" loading={busy === p.page_index} loadingLabel="جارٍ الإضافة…" onClick={() => void run([p.page_index], p.page_index)}>
                  أعد معالجة الصفحة
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="cc-version__actions">
        {reprocessable.length > 1 && (
          <Button size="sm" variant="secondary" loading={busy === 'all'} onClick={() => void run(reprocessable.map((p) => p.page_index), 'all')}>
            أعد معالجة هذه الصفحات ({reprocessable.length})
          </Button>
        )}
        {v.open_review_items > 0 && (
          <Link className={buttonClass({ variant: 'plain', size: 'sm' })} to={`/control/review?source=${encodeURIComponent(v.source_id)}`}>
            راجع {v.open_review_items === 1 ? 'العنصر' : `العناصر (${v.open_review_items})`}
          </Link>
        )}
      </div>
      {message && (
        <p className="cc-muted" role="status">
          {message}
        </p>
      )}
      {error && <ErrorState inline message={error} />}
    </li>
  );
}

export function ProcessingScreen() {
  const ov = useLoad(() => controlApi.processing(), []);
  const tools = useLoad(() => controlApi.tools(), []);
  const { reloadOverview } = useControlContext();
  const changed = () => {
    ov.reload();
    reloadOverview();
  };
  const d = ov.data;
  const missingTools = tools.data ? Object.values(tools.data.tools).filter((t) => !t.available) : [];
  return (
    <div className="cc-section">
      <SectionHeader
        title="المعالجة"
        lede="ما يجري على الخادم الآن، وما تعثّر ولماذا، وما أصبح جاهزًا. الأعداد حقيقية، وإعادة المحاولة تكمل من آخر خطوة محفوظة."
        actions={
          <Button size="sm" variant="secondary" icon={<RotateCcw size={16} />} onClick={changed}>
            حدّث
          </Button>
        }
      />
      {ov.error ? (
        <ErrorState inline message={ov.error} onRetry={ov.reload} />
      ) : !d ? (
        <LoadingState inline stage="جارٍ تحميل حالة المعالجة…" />
      ) : (
        <>
          <section className="cc-block" aria-labelledby="cc-active-h">
            <h2 id="cc-active-h" className="cc-block__title">
              يجري الآن
            </h2>
            {d.active.length === 0 ? (
              <p className="cc-muted">لا مهام جارية أو منتظرة.</p>
            ) : (
              <ul role="list" className="cc-jobs">
                {d.active.map((j) => (
                  <JobRow key={j.id} j={j} onChanged={changed} />
                ))}
              </ul>
            )}
          </section>
          <section className="cc-block" aria-labelledby="cc-attn-h">
            <h2 id="cc-attn-h" className="cc-block__title">
              تغطية غير كاملة أو صفحات تحتاج مراجعتك
            </h2>
            {d.attention.length === 0 ? (
              <EmptyState icon={<Wrench size={24} />} headingLevel={3} title="كل المصادر معالجة بالكامل" description="لا توجد نسخة فيها صفحات متعثرة أو تحتاج مراجعة." />
            ) : (
              <ul role="list" className="cc-versions">
                {d.attention.map((v) => (
                  <VersionCard key={v.version_id} v={v} onChanged={changed} />
                ))}
              </ul>
            )}
          </section>
          <section className="cc-block" aria-labelledby="cc-recent-h">
            <h2 id="cc-recent-h" className="cc-block__title">
              انتهت مؤخرًا
            </h2>
            {d.recent.length === 0 ? (
              <p className="cc-muted">لا مهام منتهية في آخر 30 يومًا.</p>
            ) : (
              <ul role="list" className="cc-jobs">
                {d.recent.map((j) => (
                  <JobRow key={j.id} j={j} onChanged={changed} />
                ))}
              </ul>
            )}
          </section>
          {missingTools.length > 0 && (
            <section className="cc-block" aria-labelledby="cc-tools-h">
              <h2 id="cc-tools-h" className="cc-block__title">
                أدوات غير مثبتة على الخادم
              </h2>
              <ul className="cc-bullets">
                {missingTools.map((t, i) => (
                  <li key={i}>
                    <BidiText as="span" dir="rtl" text={t.reason_ar ?? t.purpose_ar} />
                  </li>
                ))}
              </ul>
            </section>
          )}
          <ul className="cc-notes">
            {d.notes_ar.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
