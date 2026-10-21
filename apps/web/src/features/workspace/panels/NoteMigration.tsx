// «انقل ملاحظاتي إلى الإصدار الجديد» in the reader (Academic OS P1-T2 step 3; PRD AOS-3.13, Q35; Scenario 4, note side).
//
//  * NoteMigrationBanner — when the lecture has a newer version and personal items wait on an earlier one: a banner with
//    the counts; «معاينة النقل…» opens the preview (read-only: nothing changes before the tap); the ONE tap copies; the
//    report says what moved, what needs review and what stayed, with a one-step «تراجع». Copy, never move: the originals
//    stay on the earlier version, unchanged. On an earlier version the banner says so and opens the newer one.
//  * VersionReview — the «من إصدار سابق» part of «إعادة ربط» (ReanchorSection): each item that could not be copied safely,
//    with its old page and the page map's candidate side by side; «انسخها إلى ص …» (one tap on the candidate),
//    «اختر مكانها…» (Round 7's re-anchoring dialog, as a COPY) or «اتركها على الإصدار السابق».
// Online only (the copy is one server transaction, audited); offline, the controls are disabled with the reason.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeftRight, CopyCheck, History, ListChecks, MapPin, Undo2 } from 'lucide-react';
import { type ReanchorCopyPreview, type ReanchorCopyReport, type ReanchorPageRef, type SourceVersionView } from '@medlevo/shared';
import { Button, Dialog, StatusPill, useToast } from '../../../design';
import { ApiError, errorMessage } from '../../../lib/api';
import { getDb } from '../../../lib/localdb';
import { mergeServerAnnotations, mergeServerNotes } from '../data/local';
import type { SourceDocument } from '../data/useSourceDocument';
import {
  fetchMigrationPreview,
  hasPendingMigration,
  MIGRATION_OFFLINE_AR,
  newestVersion,
  postVersionDecision,
  runMigration,
  undoMigration,
  useMigrationVersion,
  versionReviewGroups,
  willCopyRows,
  type VersionReviewGroup,
} from './noteMigration';
import { ReanchorDialog } from './ReanchorSection';
import './noteMigration.css';

/** Loads the preview for (source → target version) while online; refreshes on every change signal. */
function usePreview(sourceId: string, toVersionId: string | null, online: boolean): { preview: ReanchorCopyPreview | null; failed: boolean; reload: () => void } {
  const [preview, setPreview] = useState<ReanchorCopyPreview | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const signal = useMigrationVersion(sourceId);
  const key = `${sourceId}|${toVersionId}|${online}`;
  const [loadedFor, setLoadedFor] = useState(key);
  if (loadedFor !== key) {
    setLoadedFor(key);
    setPreview(null);
    setFailed(false);
  }
  useEffect(() => {
    if (!online || !toVersionId) return;
    let cancelled = false;
    fetchMigrationPreview(sourceId, { toVersionId })
      .then((p) => {
        if (cancelled) return;
        setPreview(p);
        setFailed(false);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [sourceId, toVersionId, online, signal, attempt]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { preview, failed, reload };
}

const versionLabel = (no: number) => `الإصدار ${no}`;

// ─────────────────────────────── the banner ───────────────────────────────
export interface NoteMigrationBannerProps {
  sourceId: string;
  versions: readonly SourceVersionView[];
  /** the version the reader shows */
  currentVersionId: string;
  online: boolean;
  onOpenVersion: (versionId: string) => void;
  /** opens «ملاحظاتي ← إعادة ربط» (the review list) */
  onOpenReview: () => void;
}

export function NoteMigrationBanner({ sourceId, versions, currentVersionId, online, onOpenVersion, onOpenReview }: NoteMigrationBannerProps) {
  const newest = newestVersion(versions);
  const onNewest = !!newest && newest.id === currentVersionId;
  const { preview, reload } = usePreview(sourceId, newest?.id ?? null, online);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  // the report of a tap made here stays reachable (with its undo) after the dialog closes
  const [report, setReport] = useState<ReanchorCopyReport | null>(null);
  if (!newest || !preview) return null;
  const pending = hasPendingMigration(preview);
  const dismissKey = `${newest.id}|${preview.copy}|${preview.needs_review}|${report?.id ?? ''}|${report?.undone_at ?? ''}`;
  const current = versions.find((v) => v.id === currentVersionId);

  // reading an earlier version: say so, and open the newer one (its banner offers the copy)
  if (!onNewest) {
    const here = preview.earlier.find((e) => e.version.id === currentVersionId);
    if (!here || dismissed === dismissKey) return null;
    return (
      <div className="wk-banner ml-migrate-banner" role="status">
        <History size={16} aria-hidden="true" />
        <span className="ml-migrate-banner__text">
          {`تقرأ ${versionLabel(current?.version_no ?? 0)} — ملاحظاتك هنا على إصدار سابق. يوجد ${versionLabel(newest.version_no)} من هذه المحاضرة.`}
        </span>
        <Button size="sm" variant="secondary" onClick={() => onOpenVersion(newest.id)}>
          {`افتح ${versionLabel(newest.version_no)}`}
        </Button>
        <Button size="sm" variant="plain" onClick={() => setDismissed(dismissKey)}>
          لاحقًا
        </Button>
      </div>
    );
  }
  if (!preview.from_version) return null;
  const showReport = !!report && !pending;
  const show = (pending || showReport) && dismissed !== dismissKey;
  return (
    <>
      {show && (
        <div className="wk-banner ml-migrate-banner" role="status">
          <CopyCheck size={16} aria-hidden="true" />
          <span className="ml-migrate-banner__text">
            {showReport
              ? report!.undone_at !== null
                ? `تراجعت عن نقل ملاحظاتك من ${versionLabel(report!.from_version.version_no)}.`
                : `نُقلت ملاحظاتك إلى ${versionLabel(report!.to_version.version_no)}: ${report!.summary_ar}`
              : preview.state === 'ready'
                ? `يوجد إصدار أحدث من المحاضرة. لديك ملاحظات على ${versionLabel(preview.from_version.version_no)}: ${preview.summary_ar}`
                : `يوجد إصدار أحدث من المحاضرة. ${preview.reason_ar ?? ''}`}
          </span>
          {(showReport || preview.state === 'ready') && (
            <Button size="sm" variant="secondary" onClick={() => setOpen(true)} disabled={!online} title={!online ? MIGRATION_OFFLINE_AR : undefined}>
              {showReport ? 'التقرير…' : 'معاينة النقل…'}
            </Button>
          )}
          <Button size="sm" variant="plain" onClick={() => setDismissed(dismissKey)}>
            {showReport ? 'إخفاء' : 'لاحقًا'}
          </Button>
        </div>
      )}
      <MigrationDialog
        open={open}
        preview={preview}
        report={showReport || (open && report) ? report : null}
        online={online}
        onReport={setReport}
        onClose={() => setOpen(false)}
        onReview={() => {
          setOpen(false);
          onOpenReview();
        }}
        onChanged={reload}
      />
    </>
  );
}

// ─────────────────────────────── preview → tap → report ───────────────────────────────
export function MigrationDialog({
  open,
  preview,
  report,
  online,
  onReport,
  onClose,
  onReview,
  onChanged,
}: {
  open: boolean;
  preview: ReanchorCopyPreview;
  /** set after the tap (and after an undo): the dialog shows the report instead of the preview */
  report: ReanchorCopyReport | null;
  online: boolean;
  onReport: (r: ReanchorCopyReport | null) => void;
  onClose: () => void;
  onReview: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<'run' | 'undo' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const from = preview.from_version;
  const to = preview.to_version;
  if (!from) return null;
  const rows = willCopyRows(preview);
  // the latest tap between these versions (from an earlier visit or another device) can be undone from the preview too
  const lastRun = !report && preview.last_run && preview.last_run.id && preview.last_run.undone_at === null ? preview.last_run : null;

  const run = async () => {
    setBusy('run');
    setError(null);
    try {
      const res = await runMigration({ source_id: preview.source_id, from_version_id: from.id, to_version_id: to.id, map_computed_at: preview.map_computed_at });
      onReport(res.report);
      toast.show({ title: res.report.summary_ar, tone: 'success' });
      onChanged();
    } catch (e) {
      // 409: the page map changed since the preview (an owner decision, a recomputation) — nothing was copied
      setError(errorMessage(e));
      if (e instanceof ApiError && e.status === 409) onChanged();
    } finally {
      setBusy(null);
    }
  };
  const undo = async (r: ReanchorCopyReport) => {
    if (!r.id) return;
    setBusy('undo');
    try {
      const res = await undoMigration(preview.source_id, r.id);
      onReport(res.report);
      const u = res.report.undo;
      toast.show({
        title: `تراجعت عن النقل: حُذفت ${u?.tombstoned ?? 0} من النسخ على ${versionLabel(to.version_no)}${u?.kept_edited ? `، وبقيت ${u.kept_edited} عدّلتها بعد النقل` : ''}. ملاحظاتك على ${versionLabel(from.version_no)} لم تتغير.`,
        tone: 'success',
      });
      onChanged();
    } catch (e) {
      toast.show({ title: 'لم يُنفَّذ التراجع', description: errorMessage(e), tone: 'danger' });
    } finally {
      setBusy(null);
    }
  };
  const undoButton = (r: ReanchorCopyReport) => (
    <Button variant="plain" icon={<Undo2 size={16} />} loading={busy === 'undo'} disabled={!online || busy !== null} title={!online ? MIGRATION_OFFLINE_AR : undefined} onClick={() => void undo(r)}>
      تراجع عن النقل
    </Button>
  );

  const shown = report;
  return (
    <Dialog
      open={open}
      onClose={() => {
        setError(null);
        onClose();
      }}
      dismissible={busy === null}
      size="md"
      title={shown ? 'تقرير نقل الملاحظات' : `انقل ملاحظاتي إلى ${versionLabel(to.version_no)}`}
      description={`نسخ، لا نقل: تبقى ملاحظاتك الأصلية على ${versionLabel(from.version_no)} كما هي، وتُنسخ إلى ${versionLabel(to.version_no)} حيث تطابقت الصفحة بأمان. ما لا يُعرف مكانه بثقة لا يوضع تخمينًا؛ يظهر لك للمراجعة.`}
      footer={
        shown ? (
          <>
            {shown.id && shown.undone_at === null && undoButton(shown)}
            {preview.needs_review > 0 && (
              <Button variant="secondary" icon={<ListChecks size={16} />} onClick={onReview}>
                {`راجع العناصر (${preview.needs_review})`}
              </Button>
            )}
            <Button variant="primary" onClick={onClose}>
              تم
            </Button>
          </>
        ) : (
          <>
            <Button variant="plain" onClick={onClose} disabled={busy !== null}>
              إلغاء
            </Button>
            {preview.copy === 0 && preview.needs_review > 0 ? (
              <Button variant="primary" icon={<ListChecks size={16} />} onClick={onReview}>
                {`راجع العناصر (${preview.needs_review})`}
              </Button>
            ) : (
              <Button variant="primary" icon={<CopyCheck size={16} />} loading={busy === 'run'} disabled={!online || preview.copy === 0 || busy !== null} title={!online ? MIGRATION_OFFLINE_AR : undefined} onClick={() => void run()}>
                {`انقل ملاحظاتي إلى ${versionLabel(to.version_no)}`}
              </Button>
            )}
          </>
        )
      }
    >
      {shown ? (
        <div className="ml-migrate">
          <p className="ml-migrate__summary" role="status">
            {shown.undone_at !== null ? `تراجعت عن هذا النقل: حُذفت ${shown.undo?.tombstoned ?? 0} من النسخ${shown.undo?.kept_edited ? `، وبقيت ${shown.undo.kept_edited} عدّلتها بعد النقل` : ''}. لم يتغير شيء على ${versionLabel(from.version_no)}.` : shown.summary_ar}
          </p>
          <ul className="ml-migrate__counts" aria-label="نتيجة النقل">
            <li>
              <StatusPill tone="success">نُقلت بأمان</StatusPill> <span>{shown.copied + shown.already_moved}</span>
            </li>
            <li>
              <StatusPill tone="warning">تحتاج مراجعة</StatusPill> <span>{shown.needs_review}</span>
            </li>
            <li>
              <StatusPill tone="neutral">{`بقيت على ${versionLabel(from.version_no)}`}</StatusPill> <span>{shown.kept}</span>
            </li>
          </ul>
          <p className="wk-muted">{`قبل النقل: ${shown.total} = نُقل ${shown.copied + shown.already_moved} + تحتاج مراجعة ${shown.needs_review} + بقي ${shown.kept}. لم يُحذف شيء من ${versionLabel(from.version_no)}.`}</p>
        </div>
      ) : (
        <div className="ml-migrate">
          <p className="ml-migrate__summary">{preview.summary_ar}</p>
          <ul className="ml-migrate__counts" aria-label="ما سيحدث">
            <li>
              <StatusPill tone="success">سيُنسخ الآن</StatusPill> <span>{preview.copy}</span>
            </li>
            <li>
              <StatusPill tone="warning">يحتاج مراجعتك</StatusPill> <span>{preview.needs_review}</span>
            </li>
            <li>
              <StatusPill tone="neutral">{`يبقى على ${versionLabel(from.version_no)}`}</StatusPill> <span>{preview.kept}</span>
            </li>
            {preview.already_moved > 0 && (
              <li>
                <StatusPill tone="info">نُقل من قبل</StatusPill> <span>{preview.already_moved}</span>
              </li>
            )}
          </ul>
          {rows.rows.length > 0 && (
            <>
              <h3 className="ml-migrate__h">أين تُنسخ</h3>
              <ul className="ml-migrate__pages" aria-label="الصفحات التي تُنسخ إليها">
                {rows.rows.map((r) => (
                  <li key={r.key}>
                    <span>{`${r.from} في ${versionLabel(from.version_no)}`}</span>
                    <ArrowLeftRight size={14} aria-hidden="true" />
                    <span>{`${r.to} في ${versionLabel(to.version_no)}`}</span>
                    <span className="wk-muted">{r.items}</span>
                  </li>
                ))}
              </ul>
              {rows.more > 0 && <p className="wk-muted">{`و${rows.more} صفحات أخرى.`}</p>}
            </>
          )}
          {preview.needs_review > 0 && <p className="wk-muted">{`${preview.needs_review === 1 ? 'عنصر واحد يحتاج' : `${preview.needs_review} تحتاج`} مراجعتك: تجدها في «ملاحظاتي ← إعادة ربط» مع مكانها السابق والصفحة المقترحة.`}</p>}
          {preview.kept_by_reason.map((k) => (
            <p key={k.reason} className="wk-muted">{`${k.items}: ${k.reason_ar}`}</p>
          ))}
          {lastRun && (
            <div className="ml-migrate__last">
              <p className="wk-muted">{`آخر نقل: ${lastRun.summary_ar}`}</p>
              {undoButton(lastRun)}
            </div>
          )}
          {!online && <p className="wk-muted">{MIGRATION_OFFLINE_AR}</p>}
          {error && (
            <p className="ml-migrate__error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}

// ─────────────────────────────── the review list (inside «إعادة ربط») ───────────────────────────────
const thumbUrl = (pageId: string) => `/api/versions/pages/${encodeURIComponent(pageId)}/thumbnail`;

function PageThumb({ page, version }: { page: ReanchorPageRef | null; version: number }) {
  return (
    <figure className="ml-migrate-thumb">
      {page?.thumbnail ? <img src={thumbUrl(page.page_id)} alt={`صورة ${page.label_ar} من ${versionLabel(version)}`} loading="lazy" decoding="async" /> : <div className="ml-migrate-thumb__none" aria-hidden="true" />}
      <figcaption>{page ? `${page.label_ar} — ${versionLabel(version)}` : `لا صفحة مقابلة في ${versionLabel(version)}`}</figcaption>
    </figure>
  );
}

export function VersionReview({ doc, online, onGoToPage }: { doc: SourceDocument; online: boolean; onGoToPage: (i: number) => void }) {
  const toast = useToast();
  const sourceId = doc.detail.id;
  const { preview, failed, reload } = usePreview(sourceId, doc.version.id, online);
  const [placing, setPlacing] = useState<VersionReviewGroup | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (!preview || !preview.from_version || preview.state === 'none') {
    return failed ? <p className="wk-muted">تعذّر جلب ما ينتظر النقل من إصدار سابق.</p> : null;
  }
  const from = preview.from_version;
  const to = preview.to_version;
  const groups = versionReviewGroups(preview.review, from.version_no);
  const pageIndexOf = (pageId: string) => doc.pages.findIndex((p) => p.id === pageId);
  if (groups.length === 0 && preview.kept_items.length === 0) return null;

  const decide = async (g: VersionReviewGroup | null, req: Parameters<typeof postVersionDecision>[1], key: string) => {
    setBusy(key);
    try {
      const res = await postVersionDecision(sourceId, req);
      await mergeServerAnnotations(getDb(), res.annotations);
      await mergeServerNotes(getDb(), res.notes);
      const target = req.target ? pageIndexOf(req.target.page_id) : -1;
      const runId = res.report?.id ?? null;
      toast.show({
        title: res.summary_ar,
        tone: 'success',
        ...(runId ? { action: { label: 'تراجع', onClick: () => void undoMigration(sourceId, runId).then(() => toast.show({ title: 'حُذفت النسخة؛ الأصل باقٍ على الإصدار السابق.', tone: 'success' })) } } : target >= 0 ? { action: { label: 'اذهب إليها', onClick: () => onGoToPage(target) } } : {}),
      });
      if (g) setPlacing(null);
    } catch (e) {
      toast.show({ title: 'لم يُنفَّذ القرار', description: errorMessage(e), tone: 'danger' });
      if (e instanceof ApiError && e.status === 409) setPlacing(null);
      reload();
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="ml-migrate-review" aria-labelledby="ml-migrate-review-h">
      <h3 id="ml-migrate-review-h" className="ml-migrate__h">{`من ${versionLabel(from.version_no)}: تحتاج مراجعة (${preview.needs_review})`}</h3>
      <p className="wk-muted">
        {`هذه عناصر من ${versionLabel(from.version_no)} لم تُنسخ إلى ${versionLabel(to.version_no)} لأن صفحتها لم تتطابق بثقة. اختر لكل منها: انسخها إلى الصفحة المقترحة أو إلى صفحة تختارها (يبقى الأصل على ${versionLabel(from.version_no)})، أو اتركها على ${versionLabel(from.version_no)}.`}{' '}
        <Link to={`/sources/${encodeURIComponent(sourceId)}/compare?from=${encodeURIComponent(from.id)}&to=${encodeURIComponent(to.id)}`}>قارن الإصدارين صفحة بصفحة</Link>
      </p>
      {!online && <p className="wk-muted">{MIGRATION_OFFLINE_AR}</p>}
      {groups.length > 0 && (
        <ul className="wk-marks" role="list" aria-label={`تحتاج مراجعة من ${versionLabel(from.version_no)}`}>
          {groups.map((g) => {
            const suggestedIdx = g.suggested ? pageIndexOf(g.suggested.page_id) : -1;
            return (
              <li key={g.key} className="wk-region-row ml-migrate-row">
                <div className="wk-region-row__head">
                  <span className="wk-region-row__kind">{g.label}</span>
                  <StatusPill tone="warning">تحتاج مراجعة</StatusPill>
                </div>
                {g.preview && <p className="wk-reanchor__preview">«<bdi>{g.preview}</bdi>»</p>}
                <p className="wk-muted">{`مكانها في ${versionLabel(from.version_no)}: ${g.from.label_ar}`}</p>
                <p className="wk-muted">{g.reason_ar}</p>
                <div className="ml-migrate-side" aria-label="الصفحة السابقة والصفحة المقترحة جنبًا إلى جنب">
                  <PageThumb page={g.from} version={from.version_no} />
                  <PageThumb page={g.suggested} version={to.version_no} />
                </div>
                <div className="wk-rail-actions">
                  {g.suggested && (
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<CopyCheck size={16} />}
                      disabled={!online || busy !== null}
                      loading={busy === `s:${g.key}`}
                      title={!online ? MIGRATION_OFFLINE_AR : undefined}
                      onClick={() => void decide(null, { action: 'copy', items: g.items, to_version_id: to.id, target: { type: 'page', version_id: to.id, page_id: g.suggested!.page_id } }, `s:${g.key}`)}
                    >
                      {`انسخها إلى ${g.suggested.label_ar}`}
                    </Button>
                  )}
                  <Button size="sm" variant="plain" icon={<MapPin size={16} />} disabled={!online || busy !== null} title={!online ? MIGRATION_OFFLINE_AR : undefined} onClick={() => setPlacing(g)}>
                    اختر مكانها…
                  </Button>
                  <Button
                    size="sm"
                    variant="plain"
                    disabled={!online || busy !== null}
                    loading={busy === `k:${g.key}`}
                    title={!online ? MIGRATION_OFFLINE_AR : undefined}
                    onClick={() => void decide(null, { action: 'keep_on_previous', items: g.items, to_version_id: to.id }, `k:${g.key}`)}
                  >
                    {`اتركها على ${versionLabel(from.version_no)}`}
                  </Button>
                  {suggestedIdx >= 0 && (
                    <Button size="sm" variant="plain" onClick={() => onGoToPage(suggestedIdx)}>
                      افتح الصفحة المقترحة
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {preview.kept_items.length > 0 && (
        <details className="wk-reanchor__detached">
          <summary>{`بقيت على ${versionLabel(from.version_no)} باختيارك (${preview.kept_items.length})`}</summary>
          <ul className="wk-marks" role="list" aria-label={`بقيت على ${versionLabel(from.version_no)}`}>
            {preview.kept_items.map((k) => (
              <li key={`${k.kind}:${k.id}`} className="wk-region-row">
                <div className="wk-region-row__head">
                  <span className="wk-region-row__kind">{k.label_ar}</span>
                  <StatusPill tone="neutral">{`على ${versionLabel(from.version_no)}`}</StatusPill>
                </div>
                {k.preview && <p className="wk-reanchor__preview">«<bdi>{k.preview}</bdi>»</p>}
                <p className="wk-muted">{`مكانها: ${k.from.label_ar}`}</p>
                <div className="wk-rail-actions">
                  <Button
                    size="sm"
                    variant="plain"
                    disabled={!online || busy !== null}
                    loading={busy === `r:${k.id}`}
                    onClick={() => void decide(null, { action: 'review_again', items: [{ kind: k.kind, id: k.id, rev: k.rev }], to_version_id: to.id }, `r:${k.id}`)}
                  >
                    أعدها إلى المراجعة
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
      <ReanchorDialog
        group={placing}
        doc={doc}
        initialPage={placing?.suggested ? Math.max(0, pageIndexOf(placing.suggested.page_id)) : 0}
        busy={busy !== null}
        title={placing ? `أين تنسخ ${placing.kind === 'note' ? 'الملاحظة' : placing.label} في ${versionLabel(to.version_no)}؟` : undefined}
        description={`تُنسخ إلى الصفحة التي تختارها في ${versionLabel(to.version_no)}، ويبقى الأصل على ${versionLabel(from.version_no)} كما هو. لا يضعها التطبيق فوق فقرة من تلقاء نفسه.`}
        submitLabel="انسخها هنا"
        onClose={() => setPlacing(null)}
        onPlace={(target) => placing && target.type === 'page' && void decide(placing, { action: 'copy', items: placing.items, to_version_id: to.id, target: { type: 'page', version_id: target.version_id, page_id: target.page_id, region_id: target.region_id ?? null } }, `p:${placing.key}`)}
      />
    </section>
  );
}
