// «تحتاج إعادة ربط» with the owner's decision (§25; Round 7 — H3 item 2). Writing, highlights and notes whose place is
// gone are listed with where they used to be — never deleted, never put over another paragraph by the app. The OWNER
// picks the new place: a page of this source, optionally a paragraph on it (the ink group is placed at that paragraph,
// its shape kept), or keeps the item detached on purpose («محفوظة دون ربط», still listed, can be placed later). Ink on
// the same old page is one group (it moves together). The decision is one audited server call (previous anchor kept,
// revision checked: an edit made elsewhere since is never overwritten); the returned items are merged on this device.
// (Academic OS P1-T2 step 3) On a lecture with several versions the section starts with «من الإصدار N: تحتاج مراجعة»
// (NoteMigration.tsx → VersionReview): items of an earlier version that could not be copied safely to this one. The same
// place dialog is reused there AS A COPY (the original stays on its version).
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Anchor, MapPin, Unlink } from 'lucide-react';
import {
  richTextToPlain,
  type AnnotationAnchor,
  type AnnotationDTO,
  type NeedsReanchorItem,
  type NeedsReanchorNoteItem,
  type NeedsReanchorResponse,
  type ReanchorRequest,
  type ReanchorResponse,
  type RichText,
  type SourceRegionView,
} from '@medlevo/shared';
import { Button, Dialog, EmptyState, Select, StatusPill, useToast } from '../../../design';
import { api, ApiError, errorMessage } from '../../../lib/api';
import { getDb, type AnnotationRow } from '../../../lib/localdb';
import { getSyncEngine } from '../../../lib/sync';
import { fetchNeedsReanchor, fetchRegions } from '../data/api';
import { mergeServerAnnotations, mergeServerNotes } from '../data/local';
import type { SourceDocument } from '../data/useSourceDocument';
import { fullPageLabel } from '../model/pages';
import { VersionReview } from './NoteMigration';

const OFFLINE_REASON_AR = 'إعادة الربط قرار يُحفظ على الخادم ويُسجَّل في سجل التغييرات؛ تحتاج اتصالًا. القائمة تبقى محفوظة حتى تتصل.';
const INK_FAMILY = new Set(['ink', 'shape', 'text', 'sticky', 'image', 'link', 'highlight', 'underline']);

export interface ReanchorGroup {
  key: string;
  kind: 'ink' | 'highlight' | 'bookmark' | 'note';
  label: string;
  /** what it is, in words */
  preview: string | null;
  where: string | null;
  /** index (in doc.pages) of the page it used to be on, when that page is still here */
  pageIndex: number | null;
  items: ReanchorRequest['items'];
  detached: boolean;
}

function itemsAr(n: number): string {
  return n === 1 ? 'عنصر واحد' : n === 2 ? 'عنصران' : n <= 10 ? `${n} عناصر` : `${n} عنصرًا`;
}

/** Groups for the list: ink-like items from the same old page move together; highlights, bookmarks and notes alone. */
export function reanchorGroups(res: NeedsReanchorResponse, pageIdx: ReadonlyMap<string, number>): ReanchorGroup[] {
  const out: ReanchorGroup[] = [];
  const pageOf = (a: AnnotationAnchor | null) => (a?.type === 'page' ? (pageIdx.get(a.page_id) ?? null) : null);
  const fromAnnotations = (list: NeedsReanchorItem[], detached: boolean) => {
    const inkGroups = new Map<string, ReanchorGroup>();
    for (const it of list) {
      const a: AnnotationDTO = it.annotation;
      const prev = a.previous_anchor ?? a.anchor;
      const item = { kind: 'annotation' as const, id: a.id, rev: a.rev };
      if (INK_FAMILY.has(a.kind)) {
        const k = `${detached ? 'd' : 'n'}:ink:${prev.type === 'page' ? prev.page_id : prev.type === 'note_page' ? prev.note_page_id : prev.block_key}`;
        let g = inkGroups.get(k);
        if (!g) {
          g = { key: k, kind: 'ink', label: '', preview: null, where: it.previous_location_ar, pageIndex: pageOf(prev), items: [], detached };
          inkGroups.set(k, g);
          out.push(g);
        }
        g.items.push(item);
        g.label = `كتابة بالقلم (${itemsAr(g.items.length)})`;
      } else {
        const quote = (a.data as { quote?: { exact?: string } }).quote?.exact ?? null;
        out.push({
          key: `${detached ? 'd' : 'n'}:${a.id}`,
          kind: a.kind === 'text_highlight' ? 'highlight' : 'bookmark',
          label: a.kind === 'text_highlight' ? 'تظليل نص' : a.kind === 'bookmark' ? 'علامة' : 'تعليق',
          preview: quote ? quote.slice(0, 120) : null,
          where: it.previous_location_ar,
          pageIndex: pageOf(prev),
          items: [item],
          detached,
        });
      }
    }
  };
  const fromNotes = (list: NeedsReanchorNoteItem[], detached: boolean) => {
    for (const it of list) {
      const n = it.note;
      const text = (() => {
        try {
          return richTextToPlain(n.body as RichText).replace(/\s+/g, ' ').trim();
        } catch {
          return '';
        }
      })();
      out.push({ key: `${detached ? 'd' : 'n'}:note:${n.id}`, kind: 'note', label: 'ملاحظة', preview: (n.title || text).slice(0, 120) || null, where: it.previous_location_ar ?? it.reason_ar, pageIndex: pageOf(n.anchor), items: [{ kind: 'note', id: n.id, rev: n.rev }], detached });
    }
  };
  fromAnnotations(res.items, false);
  fromNotes(res.notes ?? [], false);
  fromAnnotations(res.detached?.annotations ?? [], true);
  fromNotes(res.detached?.notes ?? [], true);
  return out;
}

export function postReanchor(req: ReanchorRequest): Promise<ReanchorResponse> {
  return api.post<ReanchorResponse>('/annotations/reanchor', req, { timeoutMs: 30_000 });
}

export function ReanchorSection({ doc, local, online, onGoToPage, currentPageIndex = 0 }: { doc: SourceDocument; local: AnnotationRow[]; online: boolean; onGoToPage: (i: number) => void; currentPageIndex?: number }) {
  const toast = useToast();
  const [server, setServer] = useState<NeedsReanchorResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [placing, setPlacing] = useState<ReanchorGroup | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // the request: state is set only when it settles (no synchronous setState on the effect path)
  const request = useCallback(() => {
    if (!online) return () => undefined;
    let cancelled = false;
    fetchNeedsReanchor(doc.detail.id)
      .then((r) => !cancelled && setServer(r))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [doc.detail.id, online]);
  // a refresh after a decision clears an earlier failure at once
  const load = () => {
    if (online) setFailed(false);
    request();
  };
  // another source / back online: an earlier failure is cleared while rendering; the request runs in the effect
  const loadKey = `${online}|${doc.detail.id}`;
  const [loadedFor, setLoadedFor] = useState(loadKey);
  if (loadedFor !== loadKey) {
    setLoadedFor(loadKey);
    if (online) setFailed(false);
  }
  useEffect(() => request(), [request]);
  const pageIdx = useMemo(() => new Map(doc.pages.map((p, i) => [p.id, i])), [doc.pages]);
  const groups = useMemo(() => (server ? reanchorGroups(server, pageIdx) : []), [server, pageIdx]);
  const needs = groups.filter((g) => !g.detached);
  const detached = groups.filter((g) => g.detached);
  // flagged on this device but not (yet) on the server: listed honestly, decided after they sync
  const serverIds = new Set(groups.flatMap((g) => g.items.map((i) => i.id)));
  const localOnly = local.filter((a) => !serverIds.has(a.id));

  const decide = async (g: ReanchorGroup, req: Omit<ReanchorRequest, 'items'>) => {
    setBusy(g.key);
    try {
      // this device's own unsent edits of these items go first (the server checks the revision it saw)
      await getSyncEngine()
        .syncNow()
        .catch(() => undefined);
      const res = await postReanchor({ ...req, items: g.items });
      await mergeServerAnnotations(getDb(), res.annotations);
      await mergeServerNotes(getDb(), res.notes);
      const target = req.target?.type === 'page' ? pageIdx.get(req.target.page_id) : undefined;
      toast.show({
        title: res.summary_ar,
        tone: 'success',
        ...(target != null ? { action: { label: 'اذهب إليها', onClick: () => onGoToPage(target) } } : {}),
      });
      setPlacing(null);
      load();
    } catch (e) {
      toast.show({ title: 'لم يُنفَّذ القرار', description: errorMessage(e), tone: 'danger' });
      // (H3 review) the list the decision was made from may be stale (409: an item changed since — on another device or
      // by this device's own edits sent just before): fetch it again so the next decision carries the current revisions;
      // the place dialog held the old ones, so it closes and the owner chooses again from the fresh list
      if (e instanceof ApiError && e.status === 409) setPlacing(null);
      load();
    } finally {
      setBusy(null);
    }
  };

  const row = (g: ReanchorGroup) => (
    <li key={g.key} className="wk-region-row">
      <div className="wk-region-row__head">
        <span className="wk-region-row__kind">{g.label}</span>
        <StatusPill tone={g.detached ? 'neutral' : 'warning'}>{g.detached ? 'محفوظة دون ربط' : 'تحتاج إعادة ربط'}</StatusPill>
      </div>
      {g.preview && <p className="wk-reanchor__preview">«<bdi>{g.preview}</bdi>»</p>}
      <p className="wk-muted">مكانها السابق: {g.where ?? 'غير معروف'}</p>
      <div className="wk-rail-actions">
        <Button size="sm" variant="secondary" icon={<Anchor size={16} />} disabled={!online || busy !== null} title={!online ? OFFLINE_REASON_AR : undefined} onClick={() => setPlacing(g)}>
          اختر مكانها الجديد…
        </Button>
        {!g.detached && (
          <Button size="sm" variant="plain" icon={<Unlink size={16} />} disabled={!online || busy !== null} loading={busy === g.key} onClick={() => void decide(g, { action: 'keep_detached' })}>
            أبقِها دون ربط
          </Button>
        )}
        {g.pageIndex != null && (
          <Button size="sm" variant="plain" icon={<MapPin size={16} />} onClick={() => onGoToPage(g.pageIndex!)}>
            فتح الصفحة السابقة
          </Button>
        )}
      </div>
    </li>
  );

  return (
    <>
      {(doc.detail.versions?.length ?? 0) > 1 && <VersionReview doc={doc} online={online} onGoToPage={onGoToPage} />}
      <p className="wk-muted">
        عندما يتغير المصدر أو تخطيطه ولا يمكن إعادة ربط كتابة أو ملاحظة بثقة، تظهر هنا مع مكانها السابق. لا يُحذف شيء ولا يضعها التطبيق فوق فقرة أخرى: أنت تختار مكانها الجديد،
        أو تبقيها دون ربط. يبقى مكانها السابق محفوظًا ويُسجَّل قرارك.
      </p>
      {!online && <p className="wk-muted">{OFFLINE_REASON_AR}</p>}
      {failed && <p className="wk-muted">تعذّر جلب القائمة من الخادم؛ تُعرض العناصر المحفوظة على هذا الجهاز.</p>}
      {needs.length === 0 && localOnly.length === 0 ? (
        <EmptyState headingLevel={3} title="لا شيء يحتاج إعادة ربط" description={(doc.detail.versions?.length ?? 0) > 1 ? 'كل كتاباتك وملاحظاتك على هذا الإصدار في مواضعها.' : 'كل كتاباتك وملاحظاتك على هذا المصدر في مواضعها.'} />
      ) : (
        <ul className="wk-marks" role="list" aria-label="تحتاج إعادة ربط">
          {needs.map(row)}
          {localOnly.map((a) => (
            <li key={a.id} className="wk-region-row">
              <div className="wk-region-row__head">
                <span className="wk-region-row__kind">{a.kind === 'text_highlight' ? 'تظليل نص' : INK_FAMILY.has(a.kind) ? 'كتابة بالقلم' : 'تعليق'}</span>
                <StatusPill tone="warning">تحتاج إعادة ربط</StatusPill>
              </div>
              <p className="wk-muted">على هذا الجهاز فقط حتى الآن؛ اختيار مكانها الجديد متاح بعد المزامنة.</p>
            </li>
          ))}
        </ul>
      )}
      {detached.length > 0 && (
        <details className="wk-reanchor__detached">
          <summary>{`محفوظة دون ربط (${detached.length})`}</summary>
          <ul className="wk-marks" role="list" aria-label="محفوظة دون ربط">
            {detached.map(row)}
          </ul>
        </details>
      )}
      <ReanchorDialog group={placing} doc={doc} initialPage={placing?.pageIndex ?? currentPageIndex} busy={busy !== null} onClose={() => setPlacing(null)} onPlace={(target) => placing && void decide(placing, { action: 'move', target })} />
    </>
  );
}

/** One stable function (an inline default would be new on every render and re-run the fetch effect in a loop). */
const loadPageRegions = (pageId: string) => fetchRegions(pageId).then((r) => r.regions);

/** «أين تضعها؟»: a page of this source, then either the same place on that page or a paragraph on it. */
export function ReanchorDialog({
  group,
  doc,
  initialPage,
  busy,
  onClose,
  onPlace,
  loadRegions = loadPageRegions,
  title,
  description,
  submitLabel = 'اربطها هنا',
}: {
  group: ReanchorGroup | null;
  doc: SourceDocument;
  initialPage: number;
  busy: boolean;
  onClose: () => void;
  onPlace: (target: NonNullable<ReanchorRequest['target']>) => void;
  loadRegions?: (pageId: string) => Promise<SourceRegionView[]>;
  /** (P1-T2 step 3) the cross-version review reuses this dialog AS A COPY, with its own wording */
  title?: string;
  description?: string;
  submitLabel?: string;
}) {
  const [pageIndex, setPageIndex] = useState(initialPage);
  const [regions, setRegions] = useState<SourceRegionView[] | null>(null);
  const [regionId, setRegionId] = useState<string>('');
  const name = useId();
  // a group to place starts at the current page (reset while rendering; `null` = not seen yet, so a dialog mounted with
  // a group starts there too)
  const pageCount = doc.pages.length;
  const [placingFor, setPlacingFor] = useState<{ group: ReanchorGroup | null; initialPage: number; pageCount: number } | null>(null);
  if (!placingFor || placingFor.group !== group || placingFor.initialPage !== initialPage || placingFor.pageCount !== pageCount) {
    setPlacingFor({ group, initialPage, pageCount });
    if (group) {
      setPageIndex(Math.min(Math.max(0, initialPage), Math.max(0, pageCount - 1)));
      setRegionId('');
    }
  }
  const page = doc.pages[pageIndex];
  // another page shows its regions afresh (cleared while rendering; the request runs in the effect)
  const [regionsFor, setRegionsFor] = useState({ group, page, loadRegions });
  if (regionsFor.group !== group || regionsFor.page !== page || regionsFor.loadRegions !== loadRegions) {
    setRegionsFor({ group, page, loadRegions });
    if (group && page && group.kind !== 'note') setRegions(null);
  }
  useEffect(() => {
    if (!group || !page || group.kind === 'note') return;
    let cancelled = false;
    loadRegions(page.id)
      .then((r) => !cancelled && setRegions(r.filter((x) => !!x.bbox && !!x.text?.trim() && (x.kind === 'paragraph' || x.kind === 'text_block' || x.kind === 'heading' || x.kind === 'list_item' || x.kind === 'figure' || x.kind === 'table' || x.kind === 'caption'))))
      .catch(() => !cancelled && setRegions([]));
    return () => {
      cancelled = true;
    };
  }, [group, page, loadRegions]);
  const ink = group?.kind === 'ink';
  // a note is anchored to a page (the page anchor carries no paragraph); writing and highlights can sit AT a paragraph
  const allowRegions = group?.kind !== 'note';
  const formId = useId();
  return (
    <Dialog
      open={!!group}
      onClose={onClose}
      title={group ? (title ?? `أين تضع ${group.kind === 'note' ? 'الملاحظة' : group.label}؟`) : ''}
      description={description ?? 'لا يضعها التطبيق فوق فقرة من تلقاء نفسه؛ اختر الصفحة، ثم مكانها عليها. يبقى مكانها السابق محفوظًا.'}
      size="md"
      footer={
        <>
          <Button type="button" variant="plain" onClick={onClose}>
            إلغاء
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={busy} disabled={!page}>
            {submitLabel}
          </Button>
        </>
      }
    >
      {group && page && (
        <form
          id={formId}
          className="wk-reanchor"
          onSubmit={(e) => {
            e.preventDefault();
            onPlace({ type: 'page', version_id: page.version_id, page_id: page.id, region_id: regionId || null });
          }}
        >
          <Select<string>
            label="الصفحة"
            value={String(pageIndex)}
            onValueChange={(v) => {
              setPageIndex(Number(v));
              setRegionId('');
            }}
            options={doc.pages.map((p, i) => ({ value: String(i), label: fullPageLabel(p) }))}
          />
          {allowRegions ? (
            <fieldset className="wk-reanchor__places">
              <legend>مكانها على الصفحة</legend>
              <label className="wk-reanchor__option">
                <input type="radio" name={name} checked={regionId === ''} onChange={() => setRegionId('')} />
                <span>{ink ? 'في الموضع نفسه على الصفحة (كما كانت على صفحتها السابقة)' : 'في الموضع نفسه على الصفحة'}</span>
              </label>
              {regions === null && <p className="wk-muted">جارٍ جلب فقرات الصفحة…</p>}
              {regions?.length === 0 && <p className="wk-muted">لا توجد فقرات مقروءة على هذه الصفحة؛ ضعها في الموضع نفسه.</p>}
              {(regions ?? []).slice(0, 40).map((r) => (
                <label key={r.id} className="wk-reanchor__option">
                  <input type="radio" name={name} checked={regionId === r.id} onChange={() => setRegionId(r.id)} />
                  <span>
                    عند الفقرة: «<bdi>{(r.text ?? '').replace(/\s+/g, ' ').slice(0, 90)}</bdi>»
                  </span>
                </label>
              ))}
            </fieldset>
          ) : (
            <p className="wk-muted">تُربط الملاحظة بالصفحة المختارة، وتظهر في «ملاحظاتي» على هذه الصفحة.</p>
          )}
        </form>
      )}
    </Dialog>
  );
}
