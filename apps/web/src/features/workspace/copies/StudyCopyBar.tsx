// The copy bar of the reader (P1-T5 steps 2–3; PRD AOS-2.17–2.19, 4.1, 4.14, 19H.3, Q25; ARCHITECTURE_DELTA §6.4, §6.5,
// §6.9).
//
//  * Reading MY COPY of an official lecture: which subject and version it is, the official lecture's state said in words
//    (withdrawn — the copy and the notes stay; file removed after a rights takedown), «انقل ملاحظاتي تلقائيًا» (the copy's
//    real `reanchor_policy`, saved on the server) and a link to the lecture page. A newer official version is announced by
//    P1-T2's banner above (NoteMigrationBanner), which copies the notes with one tap — never moves them.
//  * (step 3) The same lecture studied WITH A CLASSMATE'S EXPLANATION — a followed or an independent copy on the same
//    page skeleton: «متابَعة: شرح حسن · الإصدار 1», the official version the explanation was written on («الشرح مبني على
//    الإصدار 1 من المحاضرة»), «تحديث متاح من حسن» → «اعرض التغييرات» (UpdatePreviewDialog: preview, «طبّق التحديث»,
//    «تخطَّ هذا الإصدار»), «طبّق تحديثات الشرح تلقائيًا» (the copy's real `update_policy`), and why updates stopped
//    (hidden by a moderator, withdrawn, author deleted — what the copy has stays). Arriving with `?copy=<id>` (from
//    «ابدأ الدراسة بهذا الشرح» or «افتح نسختي») makes that copy's own layer the one new writing goes to.
//  * Reading a PRIVATE lecture that exists officially in one of my subjects: «موجودة رسميًا في …» with «اربط بالنسخة
//    الرسمية…», which copies my items onto the official version (LinkToOfficialDialog); the private file is not changed.
// Everything comes from the server (the viewer's own vault and the subjects they belong to); offline, or when there is
// nothing to say, the bar is not shown at all.
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Landmark, Link2, RefreshCw, Users } from 'lucide-react';
import type { DocumentCopyView, OfficialLinkCandidate, SourceType } from '@medlevo/shared';
import { Button, StatusPill, Switch } from '../../../design';
import { errorMessage } from '../../../lib/api';
import { copiesApi, lectureUrl } from '../../copies/api';
import { LinkToOfficialDialog } from '../../copies/LinkToOfficialDialog';
import { UpdatePreviewDialog } from '../../copies/UpdatePreviewDialog';
import { publicationUrl } from '../../lectures/api';
import { useLayerViewContext } from '../ink/layers/LayerViewProvider';
import '../../copies/copies.css';
import '../../lectures/publications.css';

type BarState = { kind: 'none' } | { kind: 'copy'; copies: DocumentCopyView[] } | { kind: 'twin'; candidates: OfficialLinkCandidate[] };

/** Loads what the bar shows for one source (online only). Exported for tests. */
export async function loadCopyBar(sourceId: string, sourceType: SourceType | null): Promise<BarState> {
  const { copies } = await copiesApi.list({ source_id: sourceId });
  const ofLecture = copies.filter((c) => c.lecture);
  if (ofLecture.length) return { kind: 'copy', copies: ofLecture };
  if (sourceType !== 'lecture') return { kind: 'none' };
  const { candidates } = await copiesApi.linkCandidates(sourceId);
  return candidates.length ? { kind: 'twin', candidates } : { kind: 'none' };
}

/** «متابَعة: شرح حسن · الإصدار 1» / «نسخة مستقلة: … · الإصدار 3» */
export function explanationChipAr(c: DocumentCopyView): string {
  const p = c.publication!;
  return c.mode === 'followed' ? `متابَعة: ${p.title} · ${p.author.display_name} · الإصدار ${p.applied_version_no}` : `نسخة مستقلة: ${p.title} · الإصدار ${p.applied_version_no}`;
}

function ExplanationRow({ copy, online, onCopy }: { copy: DocumentCopyView; online: boolean; onCopy: (c: DocumentCopyView) => void }) {
  const p = copy.publication!;
  const [previewOpen, setPreviewOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const followed = copy.mode === 'followed';
  const live = p.status === 'active';
  const pending = followed && live ? copy.pending_version_no : null;
  const setAuto = async (on: boolean) => {
    setSaving(true);
    setError(null);
    try {
      onCopy(await copiesApi.patch(copy.id, { update_policy: on ? 'auto' : 'preview' }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <StatusPill tone="info" icon={<Users size={14} />}>
        {explanationChipAr(copy)}
      </StatusPill>
      {p.built_on_version_no != null && <p className="cp-bar__note">{`الشرح مبني على الإصدار ${p.built_on_version_no} من المحاضرة`}</p>}
      {p.status_note_ar && <p className="cp-bar__note">{p.status_note_ar}</p>}
      {pending !== null && (
        <div className="pb-update" role="status">
          <p className="pb-update__text">
            {`تحديث متاح من ${p.author.display_name}: الإصدار ${pending}`}
            {p.pending_built_on_version_no != null && p.pending_built_on_version_no !== p.built_on_version_no ? ` (مبني على الإصدار ${p.pending_built_on_version_no} من المحاضرة)` : ''}
          </p>
          <Button size="sm" icon={<RefreshCw size={16} />} onClick={() => setPreviewOpen(true)} disabled={!online}>
            اعرض التغييرات
          </Button>
        </div>
      )}
      {followed && live && (
        <Switch
          className="cp-bar__switch"
          checked={copy.update_policy === 'auto'}
          onCheckedChange={(on) => void setAuto(on)}
          disabled={!online || saving}
          label="طبّق تحديثات الشرح تلقائيًا"
        />
      )}
      {(live || p.status === 'hidden_by_moderator') && (
        <Link className="cp-bar__link" to={publicationUrl(p.space_id, p.id)}>
          صفحة الشرح
        </Link>
      )}
      {error && (
        <p className="cp-bar__note" role="alert">
          {error}
        </p>
      )}
      {previewOpen && <UpdatePreviewDialog open onClose={() => setPreviewOpen(false)} copy={copy} onApplied={onCopy} />}
    </>
  );
}

export function StudyCopyBar({ sourceId, sourceType, online }: { sourceId: string; sourceType: SourceType | null; online: boolean }) {
  const [state, setState] = useState<BarState>({ kind: 'none' });
  const [linkOpen, setLinkOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sp] = useSearchParams();
  const wanted = sp.get('copy');
  const layerView = useLayerViewContext();
  const applied = useRef<string | null>(null);

  useEffect(() => {
    if (!online) return;
    let cancelled = false;
    loadCopyBar(sourceId, sourceType)
      .then((s) => !cancelled && setState(s))
      // the bar is an addition to the reader: when the server cannot answer, the reader works as before
      .catch(() => !cancelled && setState({ kind: 'none' }));
    return () => {
      cancelled = true;
    };
  }, [sourceId, sourceType, online]);

  // `?copy=<id>`: the viewer came for that copy — its own layer receives new writing (once its layer has synced)
  const target = state.kind === 'copy' && wanted ? (state.copies.find((c) => c.id === wanted) ?? null) : null;
  const targetLayer = target?.personal_layer_id ?? null;
  const layerReady = !!targetLayer && !!layerView?.layers.some((l) => l.id === targetLayer);
  useEffect(() => {
    if (!layerView || !targetLayer || !layerReady || applied.current === targetLayer) return;
    applied.current = targetLayer;
    if (layerView.activeId !== targetLayer) layerView.setActive(targetLayer);
  }, [layerView, targetLayer, layerReady]);

  if (state.kind === 'none') return null;

  if (state.kind === 'twin') {
    const first = state.candidates[0]!;
    return (
      <div className="cp-bar" role="region" aria-label="المحاضرة الرسمية">
        <StatusPill tone="info" icon={<Landmark size={14} />}>
          {`موجودة رسميًا في ${first.subject.title}`}
        </StatusPill>
        <p className="cp-bar__note">{first.basis_ar.join(' · ')}</p>
        <Button size="sm" variant="secondary" icon={<Link2 size={16} />} onClick={() => setLinkOpen(true)} disabled={!online}>
          اربط بالنسخة الرسمية…
        </Button>
        {linkOpen && <LinkToOfficialDialog open onClose={() => setLinkOpen(false)} sourceId={sourceId} candidates={state.candidates} />}
      </div>
    );
  }

  const { copies } = state;
  // the lecture row speaks for the personal copy (or the first copy: they all read the same stub)
  const copy = copies.find((c) => c.mode === 'personal') ?? copies[0]!;
  const explanations = copies.filter((c) => c.publication);
  const replace = (c: DocumentCopyView) => setState((s) => (s.kind === 'copy' ? { kind: 'copy', copies: s.copies.map((x) => (x.id === c.id ? c : x)) } : s));
  const lecture = copy.lecture!;
  const official = copy.official ?? null;
  const setAuto = async (on: boolean) => {
    setSaving(true);
    setError(null);
    try {
      replace(await copiesApi.patch(copy.id, { reanchor_policy: on ? 'auto' : 'preview' }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="cp-bar" role="region" aria-label="نسختي من المحاضرة الرسمية">
      <StatusPill tone="accent" icon={<Landmark size={14} />}>
        {`نسختي · ${lecture.subject.title} · الإصدار ${lecture.version_no}`}
      </StatusPill>
      {official && official.status !== 'published' && (
        <StatusPill tone="warning">{official.status === 'withdrawn' ? 'سُحبت المحاضرة الرسمية' : 'المحاضرة الرسمية غير متاحة لك الآن'}</StatusPill>
      )}
      {official?.note_ar && <p className="cp-bar__note">{official.note_ar}</p>}
      {official?.status === 'published' && (
        <Switch
          className="cp-bar__switch"
          checked={copy.reanchor_policy === 'auto'}
          onCheckedChange={(on) => void setAuto(on)}
          disabled={!online || saving}
          label="انقل ملاحظاتي تلقائيًا إلى الإصدارات الجديدة"
        />
      )}
      {official?.status !== 'unavailable' && (
        <Link className="cp-bar__link" to={lectureUrl(lecture.space_id, lecture.lecture_id)}>
          صفحة المحاضرة
        </Link>
      )}
      {error && (
        <p className="cp-bar__note" role="alert">
          {error}
        </p>
      )}
      {explanations.map((c) => (
        <ExplanationRow key={c.id} copy={c} online={online} onCopy={replace} />
      ))}
    </div>
  );
}
