// Page actions of the writing toolbar's «المزيد» menu (parity N1):
//  * «دليل الألوان ومعانيها» (G03): every colour slot that has a meaning; «اعرض هذا المعنى فقط» hides the rest of the ink
//    for this session (nothing is deleted);
//  * «نسخة نظيفة للمراجعة» (G15, MedLevo-plus): hide chosen kinds of writing to re-read a lecture cold;
//  * «امسح الصفحة» and «احذف كل نوع في الدفتر» (G15): the count per type first, then tombstones in ONE undo step;
//  * «المحذوف بالجملة»: those removals, restorable on this device.
import { useEffect, useMemo, useState } from 'react';
import type { AnnotationAnchor } from '@medlevo/shared';
import { Button, Checkbox, Dialog, EmptyState, Select } from '../../../design';
import { applyBulk, DELETABLE_TYPES, describeCounts, listTrash, planClearPage, planDeleteByType, restoreTrash, type BulkPlan, type TrashEntry } from './bulk';
import { useInkHost } from './host';
import { useInkInternal } from './InkProvider';
import { legendOf } from './inkSettings';
import { contentTypeLabel, contentTypeOf, type InkContentType } from './kinds';
import { colorLabel, resolveInkColor } from './palette';
import { currentPaperTone } from './render';

export type InkDialogKind = 'legend' | 'clean' | 'clear_page' | 'delete_type' | 'trash';

export function InkDialogs({ open, onClose }: { open: InkDialogKind | null; onClose: () => void }) {
  return (
    <>
      <LegendDialog open={open === 'legend'} onClose={onClose} />
      <CleanViewDialog open={open === 'clean'} onClose={onClose} />
      <ClearPageDialog open={open === 'clear_page'} onClose={onClose} />
      <DeleteByTypeDialog open={open === 'delete_type'} onClose={onClose} />
      <TrashDialog open={open === 'trash'} onClose={onClose} />
    </>
  );
}

const TOOL_NAMES_AR: Record<string, string> = { pen: 'القلم', fountain: 'قلم الحبر', ball: 'القلم الجاف', highlighter: 'قلم التظليل', shape: 'الأشكال', text: 'مربعات النص' };

function LegendDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { inkSettings, legendFilter, setLegendFilter, setSettingsOpen } = useInkInternal();
  const entries = legendOf(inkSettings);
  const meanings = [...new Set(entries.map((e) => e.meaning))];
  return (
    <Dialog open={open} onClose={onClose} title="دليل الألوان ومعانيها" description="المعنى يُحفظ مع كل خط يُكتب بذلك اللون ويُقرأ مع اللون لقارئ الشاشة. الإخفاء هنا مؤقت لهذه الجلسة ولا يحذف شيئًا.">
      {entries.length === 0 ? (
        <EmptyState
          title="لم تسمِّ معاني الألوان بعد"
          description="سمِّ لكل لون معنى (مثل: أحمر = موانع استعمال، أزرق = آلية) في «إعدادات الكتابة» ← «الألوان ومعانيها»."
          actions={
            <Button
              onClick={() => {
                onClose();
                setSettingsOpen(true);
              }}
            >
              افتح إعدادات الكتابة
            </Button>
          }
        />
      ) : (
        <div className="ml-ink-legend" dir="rtl">
          <ul className="ml-ink-legend__list" role="list">
            {entries.map((e, i) => (
              <li key={`${e.tool}:${e.color}:${i}`} className="ml-ink-legend__row">
                <span className="ml-ink-swatch" style={{ background: resolveInkColor(e.color, currentPaperTone(), null) }} aria-hidden="true" />
                <span className="ml-ink-legend__meaning">{e.meaning}</span>
                <span className="ml-ink-legend__meta">
                  {colorLabel(e.color)} — {TOOL_NAMES_AR[e.tool] ?? e.tool}
                </span>
              </li>
            ))}
          </ul>
          <div className="ml-ink-legend__filters" role="group" aria-label="اعرض معنى واحدًا فقط">
            {meanings.map((m) => (
              <Button key={m} size="sm" variant={legendFilter === m ? 'primary' : 'secondary'} aria-pressed={legendFilter === m} onClick={() => setLegendFilter(legendFilter === m ? null : m)}>
                {`اعرض «${m}» فقط`}
              </Button>
            ))}
            {legendFilter && (
              <Button size="sm" variant="plain" onClick={() => setLegendFilter(null)}>
                اعرض كل المعاني
              </Button>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

const CLEAN_TYPES: InkContentType[] = ['highlighter', 'pen', 'shape', 'text', 'sticky', 'image'];

function CleanViewDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { cleanHidden, setCleanHidden } = useInkInternal();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="نسخة نظيفة للمراجعة"
      description="أخفِ ما تختاره من كتابتك لتقرأ المحاضرة من جديد كأنك تراها أول مرة. لا يُمحى شيء؛ يعود كل شيء حين تلغي الإخفاء أو تغادر الملف."
      footer={
        <Button variant="plain" onClick={() => setCleanHidden(new Set())} disabled={cleanHidden.size === 0}>
          أظهر كل شيء
        </Button>
      }
    >
      <div className="ml-ink-clean" dir="rtl">
        {CLEAN_TYPES.map((t) => (
          <Checkbox
            key={t}
            checked={cleanHidden.has(t)}
            label={`أخفِ ${contentTypeLabel(t, 2)}`}
            onCheckedChange={(v) => {
              const next = new Set(cleanHidden);
              if (v) next.add(t);
              else next.delete(t);
              setCleanHidden(next);
            }}
          />
        ))}
        <p className="ml-ink-options__note">تظليلات النص المطبوع يرسمها القارئ نفسه، وتُخفى من لوحة «الطبقات».</p>
      </div>
    </Dialog>
  );
}

/**
 * The page «امسح الصفحة» acts on, and its name. (Review of N1 wave 1) The page the reader SHOWS comes first: the page
 * written on last may be pages away by now, and clearing it would remove writing the owner is not looking at. Without a
 * host that knows the page in view, the page written on last.
 */
function useActivePage(open: boolean): { targetKey: string; name: string } | null {
  const host = useInkHost();
  const { store } = useInkInternal();
  return useMemo(() => {
    if (!open) return null;
    const here = host?.currentPage();
    const targetKey = here?.targetKey ?? store.activeTargetKey ?? null;
    if (!targetKey) return null;
    const anchor = here?.targetKey === targetKey ? here.anchor : (store.page(targetKey)?.anchor ?? null);
    return { targetKey, name: pageName(anchor) };
  }, [open, host, store]);
}

/** «الصفحة ٧» for a page of a file; a notebook page is «صفحة الدفتر هذه». */
function pageName(anchor: AnnotationAnchor | null | undefined): string {
  if (anchor && anchor.type === 'page') return `الصفحة ${(anchor.page_index + 1).toLocaleString('ar-EG')}`;
  return 'صفحة الدفتر هذه';
}

function ClearPageDialog({ open, onClose: close }: { open: boolean; onClose: () => void }) {
  const { store, announce } = useInkInternal();
  const active = useActivePage(open);
  const targetKey = active?.targetKey ?? null;
  const [all, setAll] = useState<BulkPlan | null>(null);
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  // a count from an earlier opening is never shown (nor applied) again
  const onClose = () => {
    setAll(null);
    close();
  };
  useEffect(() => {
    if (!open || !targetKey) return;
    let alive = true;
    void planClearPage(store, targetKey).then((p) => {
      if (!alive) return;
      setAll(p);
      setOff(new Set());
    });
    return () => {
      alive = false;
    };
  }, [open, targetKey, store]);
  const chosen = useMemo(() => {
    if (!all) return null;
    const changes = all.changes.filter((c) => !off.has(typeOfChange(c)));
    const byType: Record<string, number> = {};
    for (const [t, n] of Object.entries(all.byType)) if (!off.has(t)) byType[t] = n;
    return { ...all, changes, byType, total: changes.length };
  }, [all, off]);
  const types = all ? Object.keys(all.byType) : [];
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="امسح الصفحة"
      description="يُمحى ما كتبته على هذه الصفحة فقط، بخطوة تراجع واحدة، ويبقى في «المحذوف بالجملة» لتستعيده. النص المطبوع في الملف لا يُمس، ولا ما في طبقة مخفية أو للقراءة فقط أو مقفل."
      footer={
        <>
          <Button variant="plain" onClick={onClose}>
            إلغاء
          </Button>
          <Button
            variant="destructive"
            disabled={!chosen || chosen.total === 0 || busy}
            onClick={async () => {
              if (!chosen) return;
              setBusy(true);
              const n = await applyBulk(store, chosen);
              setBusy(false);
              announce(`مُسح ${n.toLocaleString('ar-EG')} عنصر من ${active?.name ?? 'الصفحة'}. يمكنك التراجع.`);
              onClose();
            }}
          >
            {chosen ? `امسح ${chosen.total.toLocaleString('ar-EG')} عنصر` : 'امسح'}
          </Button>
        </>
      }
    >
      <div className="ml-ink-bulk" dir="rtl">
        {active && <p className="ml-ink-bulk__page">{`الصفحة التي تُمسح: ${active.name}`}</p>}
        {!targetKey ? (
          <p>المس الصفحة التي تريد مسحها أولًا.</p>
        ) : !all ? (
          <p>يُعدّ ما على الصفحة…</p>
        ) : all.total === 0 ? (
          <p>لا يوجد على هذه الصفحة ما يمكن مسحه.</p>
        ) : (
          <>
            <p className="ml-ink-bulk__count" role="status">
              {`سيُمسح: ${describeCounts(chosen?.byType ?? {}) || 'لا شيء'}.`}
            </p>
            <fieldset className="ml-ink-bulk__types">
              <legend className="ml-field__label">ما يُمسح</legend>
              {types.map((t) => (
                <Checkbox
                  key={t}
                  checked={!off.has(t)}
                  label={`${contentTypeLabel(t, 2)} (${(all.byType[t] ?? 0).toLocaleString('ar-EG')})`}
                  onCheckedChange={(v) => {
                    const next = new Set(off);
                    if (v) next.delete(t);
                    else next.add(t);
                    setOff(next);
                  }}
                />
              ))}
            </fieldset>
          </>
        )}
      </div>
    </Dialog>
  );
}

/** The content type of a planned removal — the same grouping as the plan's counts (a registered kind's own type too). */
function typeOfChange(c: BulkPlan['changes'][number]): string {
  return contentTypeOf(c.before!);
}

function DeleteByTypeDialog({ open, onClose: close }: { open: boolean; onClose: () => void }) {
  const { store, announce, documentKey } = useInkInternal();
  const [type, setType] = useState<InkContentType>('highlighter');
  /** the plan counted for the type chosen (a plan of another type is never shown or applied) */
  const [counted, setCounted] = useState<{ type: InkContentType; plan: BulkPlan } | null>(null);
  const plan = counted && counted.type === type ? counted.plan : null;
  const [busy, setBusy] = useState(false);
  const onClose = () => {
    setCounted(null);
    close();
  };
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void planDeleteByType(store, type, store.activeTargetKey ? [store.activeTargetKey] : []).then((p) => alive && setCounted({ type, plan: p }));
    return () => {
      alive = false;
    };
  }, [open, type, store, documentKey]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="احذف كل نوع في الدفتر"
      description="يُحذف النوع الذي تختاره من كل صفحات هذا الملف أو الدفتر المحفوظة على هذا الجهاز، بخطوة تراجع واحدة، ويبقى في «المحذوف بالجملة». لا يُمس النص المطبوع، ولا ما في طبقة مخفية أو للقراءة فقط أو مقفل."
      footer={
        <>
          <Button variant="plain" onClick={onClose}>
            إلغاء
          </Button>
          <Button
            variant="destructive"
            disabled={!plan || plan.total === 0 || busy}
            onClick={async () => {
              if (!plan) return;
              setBusy(true);
              const n = await applyBulk(store, plan);
              setBusy(false);
              announce(`حُذف ${n.toLocaleString('ar-EG')} عنصر. يمكنك التراجع.`);
              onClose();
            }}
          >
            {plan ? `احذف ${plan.total.toLocaleString('ar-EG')} عنصر` : 'احذف'}
          </Button>
        </>
      }
    >
      <div className="ml-ink-bulk" dir="rtl">
        <Select
          label="النوع"
          value={type}
          options={DELETABLE_TYPES.map((t) => ({ value: t, label: contentTypeLabel(t, 2) }))}
          onValueChange={(v) => setType(v as InkContentType)}
        />
        <p className="ml-ink-bulk__count" role="status">
          {!plan ? 'يُعدّ…' : plan.total === 0 ? `لا توجد ${contentTypeLabel(type, 2)} يمكن حذفها.` : `سيُحذف ${describeCounts(plan.byType)} من ${plan.pages.toLocaleString('ar-EG')} صفحة.`}
        </p>
      </div>
    </Dialog>
  );
}

function TrashDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { store, announce } = useInkInternal();
  const [entries, setEntries] = useState<TrashEntry[] | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void listTrash(store).then((e) => alive && setEntries(e));
    return () => {
      alive = false;
    };
  }, [open, store, version]);
  return (
    <Dialog open={open} onClose={onClose} title="المحذوف بالجملة" description="ما مسحته بـ«امسح الصفحة» أو «احذف كل نوع» في هذا الملف، محفوظ على هذا الجهاز. الاستعادة تعيد العناصر كما كانت (ما أُعيد أو عُدّل بعدها يبقى كما هو).">
      <div className="ml-ink-trash" dir="rtl">
        {!entries ? (
          <p>يُحمَّل…</p>
        ) : entries.length === 0 ? (
          <p>لا يوجد محذوف بالجملة في هذا الملف.</p>
        ) : (
          <ul className="ml-ink-trash__list" role="list">
            {entries.map((e) => (
              <li key={e.id} className="ml-ink-trash__row">
                <span className="ml-ink-trash__what">
                  <strong>{e.label_ar}</strong>
                  <span>{describeCounts(e.byType)}</span>
                  <time dateTime={new Date(e.at).toISOString()}>{new Date(e.at).toLocaleString('ar-EG')}</time>
                </span>
                <Button
                  size="sm"
                  onClick={async () => {
                    const n = await restoreTrash(store, e.id);
                    announce(n ? `استُعيد ${n.toLocaleString('ar-EG')} عنصر.` : 'كل عناصرها موجودة أصلًا؛ لا شيء يُستعاد.');
                    setVersion((v) => v + 1);
                  }}
                >
                  استعِد
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
