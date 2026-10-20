// /explanations/:artifactId — one generated explanation / summary / comparison on its own page (Round 7 H4): reached
// from a topic it is linked to. It says plainly that it is GENERATED content checked against the cited sources (never a
// lecture text), shows its version and whether a newer one exists, opens the place in the source it explains, and
// links it to topics. The content renders through the evidence pipeline's ArtifactContent (chips → Evidence Peek).
import { Link, useParams } from 'react-router-dom';
import { ARTIFACT_KIND_LABELS_AR, type StudyArtifactView } from '@medlevo/shared';
import { Breadcrumbs, ErrorState, LoadingState, StatusPill } from '../../design';
import { usePageTitle } from '../../lib/usePageTitle';
import { ArtifactContent } from '../evidence';
import { TopicLinksControl } from '../brain/TopicLinksControl';
import { useQuery } from '../library/data';
import '../review/learning.css';

export function artifactSourceHref(a: Pick<StudyArtifactView, 'anchor' | 'primary_source_id'>): string | null {
  const sourceId = a.anchor?.source_id ?? a.primary_source_id;
  if (!sourceId) return null;
  const q = new URLSearchParams();
  if (a.anchor?.version_id) q.set('v', a.anchor.version_id);
  if (a.anchor?.page_id) q.set('page_id', a.anchor.page_id);
  if (a.anchor?.region_ids?.[0]) q.set('region', a.anchor.region_ids[0]);
  const s = q.toString();
  return `/study/${encodeURIComponent(sourceId)}${s ? `?${s}` : ''}`;
}

export function ArtifactScreen() {
  const { artifactId = '' } = useParams();
  const q = useQuery<{ artifact: StudyArtifactView }>(`/studybook/artifacts/${encodeURIComponent(artifactId)}`, { cache: true });
  const a = q.data?.artifact ?? null;
  const kindLabel = a ? (ARTIFACT_KIND_LABELS_AR[a.kind] ?? 'محتوى مولّد') : 'محتوى مولّد';
  usePageTitle(a?.title ?? kindLabel);
  if (q.loading && !a) return <LoadingState stage="جارٍ تحميل الشرح…" />;
  if (q.error && !a) {
    return (
      <div className="ml-page">
        <ErrorState title={q.error.status === 404 ? 'الشرح غير موجود' : 'تعذّر تحميل الشرح'} message={q.error.message} onRetry={q.error.status === 404 ? undefined : () => void q.refresh()} />
      </div>
    );
  }
  const art = a!;
  const newer = art.versions.filter((v) => v.version_no > art.version_no).sort((x, y) => y.version_no - x.version_no)[0] ?? null;
  const sourceHref = artifactSourceHref(art);
  return (
    <div className="ml-page lw-page">
      <Breadcrumbs items={[{ label: 'المكتبة', to: '/library' }, { label: 'الموضوعات', to: '/library/topics' }, { label: <bdi>{art.title ?? kindLabel}</bdi> }]} />
      <header className="ml-page__header">
        <h1 className="ml-page__title">
          <bdi>{art.title ?? kindLabel}</bdi>
        </h1>
        <p className="lw-muted">
          {kindLabel} — نص مولّد فُحصت جمله الطبية مقابل المصادر المذكورة؛ ليس نصًا من المحاضرة.
          {` النسخة ${art.version_no}.`}
        </p>
        <div className="kb-actions">
          {art.status === 'stale' && <StatusPill tone="warning">{`قديم — ${art.stale_reason ?? 'تغيّر مصدره'}`}</StatusPill>}
          {art.is_frozen && <StatusPill tone="neutral">مجمَّد على نسخته</StatusPill>}
          {newer && (
            <Link className="lw-link" to={`/explanations/${encodeURIComponent(newer.id)}`}>
              {`توجد نسخة أحدث (${newer.version_no})`}
            </Link>
          )}
          {sourceHref && (
            <Link className="lw-link" to={sourceHref}>
              افتح الموضع في المصدر
            </Link>
          )}
        </div>
        <TopicLinksControl entityType="artifact" entityId={art.id} itemLabel={art.title ?? kindLabel} disabled={q.fromCache} />
      </header>
      {q.fromCache && <p className="lw-note">معروض من آخر نسخة محفوظة على هذا الجهاز (دون اتصال).</p>}
      <ArtifactContent artifact={art} />
    </div>
  );
}
