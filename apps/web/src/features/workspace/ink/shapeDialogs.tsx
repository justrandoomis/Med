// Dialogs opened from the lasso selection (parity N1 wave 2):
//  * «خصائص الشكل» (G20 / G21) — kind (within its family), pathway head, fill, rounded corners, the connector's route and
//    its medical relation; every change is one undo step and is announced;
//  * «اربط بمفهوم من المادة» (G21) — binds a node to a Course Brain concept (search needs the connection);
//  * «تحقّق من العلاقات» (G21) — each connector between two concepts checked against the knowledge map (a read);
//  * «أعد ترتيب الكلمات» (G10 phase 2) — only with handwriting recognition: read, preview, apply (one undo step).
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  BOX_SHAPES,
  CONNECTOR_RELATION_LABELS_AR,
  CONNECTOR_RELATIONS,
  CONNECTOR_ROUTE_LABELS_AR,
  CONNECTOR_ROUTES,
  LINE_SHAPES,
  PATHWAY_HEAD_LABELS_AR,
  PATHWAY_HEADS,
  richTextFromPlain,
  SHAPE_KIND_LABELS_AR,
  type BrainConceptListResponse,
  type ConceptRelationListResponse,
  type ShapeData,
} from '@medlevo/shared';
import { Button, Dialog, TextField } from '../../../design';
import { api } from '../../../lib/api';
import { checkRelation, connectorSentence, isConnector, nodeName, RELATION_CHECK_LABELS_AR, type RelationCheck } from './connectors';
import { reflowPlan, writtenLines } from './handwritingLayout';
import { isInkStroke, isShape, nowMs, type InkItem, type InkItemOf } from './model';
import { colorLabel } from './palette';
import { readForReflow } from './reflow';
import type { InkDocumentStore } from './store';

type ShapeItem = InkItemOf<ShapeData>;

function Chips({ label, options, value, onChange }: { label: string; options: ReadonlyArray<{ value: string; label: string }>; value: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <fieldset className="ml-ink-chips ml-ink-options__group">
      <legend className="ml-field__label" id={id}>
        {label}
      </legend>
      <div className="ml-ink-chips__row">
        {options.map((o) => (
          <button key={o.value} type="button" className="ml-ink-chip" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** One undo step: the selected shapes with `patch(data)` applied (only the ones it changes). */
function editShapes(store: InkDocumentStore, targetKey: string, items: readonly ShapeItem[], label: string, patch: (d: ShapeData) => ShapeData | null) {
  const now = nowMs();
  const changes = items
    .filter((it) => store.isEditable(it) && !it.locked)
    .map((it) => {
      const data = patch(it.data);
      return data && data !== it.data ? { id: it.id, targetKey, before: it as InkItem, after: { ...it, data, tool: data.shape, updated_at: now } as InkItem } : null;
    })
    .filter((c): c is NonNullable<typeof c> => !!c);
  store.commit(label, changes);
  return changes.length;
}

const without = (d: ShapeData, key: keyof ShapeData): ShapeData => {
  const out = { ...d };
  delete out[key];
  return out;
};

export function ShapePropsDialog({ open, onClose, store, targetKey, ids, announce }: { open: boolean; onClose: () => void; store: InkDocumentStore; targetKey: string; ids: readonly string[]; announce: (m: string) => void }) {
  const [, setVersion] = useState(0);
  useEffect(() => store.subscribePage(targetKey, (e) => e.kind === 'items' && setVersion((v) => v + 1)), [store, targetKey]);
  const shapes = ids.map((id) => store.item(targetKey, id)).filter((i): i is ShapeItem => !!i && isShape(i));
  if (!open) return null;
  const first = shapes[0];
  const lineFamily = shapes.length > 0 && shapes.every((s) => (LINE_SHAPES as readonly string[]).includes(s.data.shape));
  const boxFamily = shapes.length > 0 && shapes.every((s) => (BOX_SHAPES as readonly string[]).includes(s.data.shape));
  const closed = shapes.length > 0 && shapes.every((s) => s.data.shape !== 'line' && !(LINE_SHAPES as readonly string[]).includes(s.data.shape));
  const apply = (label: string, patch: (d: ShapeData) => ShapeData | null, said: string) => {
    if (editShapes(store, targetKey, shapes, label, patch)) announce(`${said} — يمكنك التراجع.`);
  };
  const kinds = (lineFamily ? LINE_SHAPES : boxFamily ? BOX_SHAPES : []).map((k) => ({ value: k, label: SHAPE_KIND_LABELS_AR[k] }));
  const sameKind = first && shapes.every((s) => s.data.shape === first.data.shape) ? first.data.shape : '';
  const head = first && shapes.every((s) => (s.data.head ?? 'none') === (first.data.head ?? 'none')) ? (first.data.head ?? 'none') : '';
  const fill = first && shapes.every((s) => (s.data.fill ?? 'none') === (first.data.fill ?? 'none')) ? (first.data.fill ?? 'none') : '';
  const route = first && shapes.every((s) => (s.data.route ?? 'straight') === (first.data.route ?? 'straight')) ? (first.data.route ?? 'straight') : '';
  const relation = first && shapes.every((s) => (s.data.relation ?? 'none') === (first.data.relation ?? 'none')) ? (first.data.relation ?? 'none') : '';
  return (
    <Dialog open={open} onClose={onClose} title="خصائص الشكل" size="sm" description={shapes.length > 1 ? `تُطبَّق على ${shapes.length.toLocaleString('ar-EG')} أشكال محددة. كل تغيير خطوة تراجع واحدة.` : 'كل تغيير خطوة تراجع واحدة.'}>
      <div className="ml-ink-options" dir="rtl">
        {kinds.length > 1 && (
          <Chips
            label="نوع الشكل"
            options={kinds}
            value={sameKind}
            onChange={(v) => apply('تغيير نوع الشكل', (d) => (d.shape === v ? d : { ...d, shape: v as ShapeData['shape'] }), `صار ${SHAPE_KIND_LABELS_AR[v as ShapeData['shape']]}`)}
          />
        )}
        {lineFamily && (
          <Chips
            label="رأس السهم (ترميز المسارات)"
            options={[{ value: 'none', label: 'رأس عادي' }, ...PATHWAY_HEADS.map((h) => ({ value: h, label: `${PATHWAY_HEAD_LABELS_AR[h]} (${h === 'activation' ? '→' : h === 'inhibition' ? '⊣' : '⇢'})` }))]}
            value={head}
            onChange={(v) => apply('رأس السهم', (d) => (v === 'none' ? without(d, 'head') : { ...d, head: v as ShapeData['head'], ...(d.shape === 'line' ? { shape: 'arrow' } : {}) }), v === 'none' ? 'رأس عادي' : `رأس «${PATHWAY_HEAD_LABELS_AR[v as 'activation']}»`)}
          />
        )}
        {lineFamily && (
          <Chips
            label="المسار"
            options={CONNECTOR_ROUTES.map((r) => ({ value: r, label: CONNECTOR_ROUTE_LABELS_AR[r] }))}
            value={route}
            onChange={(v) => apply('مسار الموصِّل', (d) => (d.shape === 'curved_arrow' ? d : v === 'straight' ? without(without(d, 'route'), 'control') : { ...without(d, 'control'), route: v as ShapeData['route'] }), `مسار ${CONNECTOR_ROUTE_LABELS_AR[v as 'elbow']}`)}
          />
        )}
        {lineFamily && (
          <Chips
            label="العلاقة الطبية"
            options={[{ value: 'none', label: 'بلا علاقة' }, ...CONNECTOR_RELATIONS.map((r) => ({ value: r, label: CONNECTOR_RELATION_LABELS_AR[r] }))]}
            value={relation}
            onChange={(v) =>
              apply(
                'نوع العلاقة',
                (d) => {
                  if (v === 'none') return without(d, 'relation');
                  // «يثبّط» is drawn with the inhibition head (⊣) unless the owner chose another
                  return { ...d, relation: v as ShapeData['relation'], ...(v === 'inhibits' && !d.head ? { head: 'inhibition' as const } : {}) };
                },
                v === 'none' ? 'بلا علاقة' : `العلاقة: ${CONNECTOR_RELATION_LABELS_AR[v as 'causes']}`,
              )
            }
          />
        )}
        {closed && (
          <Chips
            label="التعبئة"
            options={[{ value: 'none', label: 'بلا تعبئة' }, ...['hl-yellow', 'hl-green', 'hl-pink', 'hl-blue', 'hl-orange'].map((t) => ({ value: t, label: colorLabel(t) }))]}
            value={fill}
            onChange={(v) => apply('تعبئة الشكل', (d) => (v === 'none' ? without(d, 'fill') : { ...d, fill: v }), v === 'none' ? 'بلا تعبئة' : `تعبئة ${colorLabel(v)}`)}
          />
        )}
        {shapes.some((s) => s.data.shape === 'rect') && (
          <button
            type="button"
            className="ml-ink-chip"
            aria-pressed={shapes.every((s) => s.data.shape !== 'rect' || !!s.data.corner)}
            onClick={() => {
              const on = !shapes.every((s) => s.data.shape !== 'rect' || !!s.data.corner);
              apply('زوايا الشكل', (d) => (d.shape !== 'rect' ? d : on ? { ...d, corner: Math.min(0.2, Math.max(0.002, Math.min(Math.abs(d.to[0] - d.from[0]), Math.abs(d.to[1] - d.from[1])) * 0.2)) } : without(d, 'corner')), on ? 'زوايا مستديرة' : 'زوايا حادة');
            }}
          >
            زوايا مستديرة
          </button>
        )}
      </div>
    </Dialog>
  );
}

// ─── concepts (G21) ─────────────────────────────────────────────────────────────────────────────
export function ConceptDialog({ open, onClose, store, targetKey, id, sourceId, announce }: { open: boolean; onClose: () => void; store: InkDocumentStore; targetKey: string; id: string | null; sourceId: string | null; announce: (m: string) => void }) {
  const [q, setQ] = useState('');
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'done'; items: BrainConceptListResponse['items'] }>({ kind: 'idle' });
  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  const node = id ? store.item(targetKey, id) : undefined;
  const search = async () => {
    setState({ kind: 'loading' });
    try {
      const res = await api.get<BrainConceptListResponse>('/brain/concepts', { query: { q: q.trim() || undefined, source_id: sourceId ?? undefined } });
      setState({ kind: 'done', items: res.items.filter((c) => c.status !== 'rejected').slice(0, 30) });
    } catch {
      setState({ kind: 'error', message: 'تعذّر البحث في مفاهيم المادة الآن. حاول عند توفر الاتصال.' });
    }
  };
  const bind = (c: { id: string; name: string } | null) => {
    if (!node || !isShape(node)) return;
    const d = node.data;
    const data: ShapeData = c ? { ...d, concept_id: c.id, concept_name: c.name.slice(0, 300), ...(d.label ? {} : { label: richTextFromPlain(c.name.slice(0, 500)) }) } : without(without(d, 'concept_id'), 'concept_name');
    store.commit(c ? 'ربط بمفهوم' : 'إزالة ربط المفهوم', [{ id: node.id, targetKey, before: node, after: { ...node, data, updated_at: nowMs() } }]);
    announce(c ? `رُبط الشكل بالمفهوم «${c.name}».` : 'أُزيل ربط الشكل بالمفهوم.');
    onClose();
  };
  if (!open || !node || !isShape(node)) return null;
  return (
    <Dialog open={open} onClose={onClose} title="اربط الشكل بمفهوم من المادة" size="sm" description="المفاهيم من «دماغ المقرر» (Course Brain). الربط يحفظ معرّف المفهوم واسمه مع الشكل، ويُستعمل للتحقق من العلاقات ولأسئلة إخفاء العقد لاحقًا.">
      <div className="ml-ink-options" dir="rtl">
        {node.data.concept_name && (
          <p className="ml-ink-options__note">
            مربوط الآن بـ «<bdi>{node.data.concept_name}</bdi>».{' '}
            <button type="button" className="ml-ink-linkbtn" onClick={() => bind(null)}>
              أزل الربط
            </button>
          </p>
        )}
        <form
          className="ml-ink-concept__form"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <TextField label="ابحث عن مفهوم" value={q} onChange={(e) => setQ(e.target.value)} dir="auto" disabled={!online} />
          <Button type="submit" size="sm" disabled={!online || state.kind === 'loading'}>
            ابحث
          </Button>
        </form>
        {!online && <p className="ml-ink-options__note">البحث في مفاهيم المادة يحتاج اتصالًا بالخادم. ما ربطته من قبل يبقى محفوظًا دون اتصال.</p>}
        {state.kind === 'loading' && <p className="ml-ink-options__note">جارٍ البحث…</p>}
        {state.kind === 'error' && <p role="alert">{state.message}</p>}
        {state.kind === 'done' &&
          (state.items.length === 0 ? (
            <p className="ml-ink-options__note">لا توجد مفاهيم بهذا الاسم في المادة. تُستخرج المفاهيم من المحاضرات المعالجة.</p>
          ) : (
            <ul className="ml-ink-concept__list">
              {state.items.map((c) => (
                <li key={c.id}>
                  <button type="button" className="ml-ink-chip" onClick={() => bind({ id: c.id, name: c.name })}>
                    <bdi>{c.name}</bdi>
                    {c.status === 'suggested' ? ' (مقترح)' : ''}
                  </button>
                </li>
              ))}
            </ul>
          ))}
      </div>
    </Dialog>
  );
}

export function RelationCheckDialog({ open, onClose, store, targetKey, ids }: { open: boolean; onClose: () => void; store: InkDocumentStore; targetKey: string; ids: readonly string[] }) {
  const [rows, setRows] = useState<Array<{ id: string; sentence: string; check: RelationCheck | { status: 'error' } }> | null>(null);
  const started = useRef(false);
  const connectors = useMemo(() => ids.map((id) => store.item(targetKey, id)).filter((i): i is ShapeItem => !!i && isConnector(i)), [ids, store, targetKey]);
  useEffect(() => {
    if (!open || started.current) return;
    started.current = true;
    const name = (id: string) => {
      const it = store.item(targetKey, id);
      return it && isShape(it) ? nodeName(it.data) : null;
    };
    const concept = (id: string | undefined) => {
      const it = id ? store.item(targetKey, id) : undefined;
      return it && isShape(it) ? (it.data.concept_id ?? null) : null;
    };
    void (async () => {
      const out: NonNullable<typeof rows> = [];
      const cache = new Map<string, ConceptRelationListResponse['items']>();
      for (const c of connectors) {
        const ends = { from: concept(c.data.attach?.from?.id), to: concept(c.data.attach?.to?.id) };
        let check: RelationCheck | { status: 'error' } = checkRelation(c.data, ends, []);
        if (check.status === 'missing' && ends.from) {
          try {
            let rel = cache.get(ends.from);
            if (!rel) {
              rel = (await api.get<ConceptRelationListResponse>('/brain/relations', { query: { concept_id: ends.from } })).items;
              cache.set(ends.from, rel);
            }
            check = checkRelation(c.data, ends, rel);
          } catch {
            check = { status: 'error' };
          }
        }
        out.push({ id: c.id, sentence: connectorSentence(c.data, name), check });
      }
      setRows(out);
    })();
  }, [open, connectors, store, targetKey]);
  if (!open) return null;
  return (
    <Dialog open={open} onClose={onClose} title="تحقّق من العلاقات في خريطة المعرفة" size="sm" description="قراءة فقط: لا يتغير شيء في رسمك ولا في خريطة المعرفة. «غير موجودة» لا تعني أن العلاقة خطأ.">
      {!rows ? (
        <p>جارٍ التحقق…</p>
      ) : rows.length === 0 ? (
        <p>لا توجد موصِّلات في التحديد.</p>
      ) : (
        <ul className="ml-ink-relations" dir="rtl">
          {rows.map((r) => (
            <li key={r.id}>
              <bdi>{r.sentence}</bdi> — {r.check.status === 'error' ? 'تعذّر التحقق الآن (يحتاج اتصالًا بالخادم).' : r.check.status === 'found' ? `${RELATION_CHECK_LABELS_AR.found} (${r.check.support === 'stated' ? 'مذكورة في المحاضرة' : 'مستنتجة'})` : RELATION_CHECK_LABELS_AR[r.check.status]}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

// ─── word reflow (G10 phase 2) ──────────────────────────────────────────────────────────────────
export function ReflowDialog({ open, onClose, store, targetKey, ids, ar, announce }: { open: boolean; onClose: () => void; store: InkDocumentStore; targetKey: string; ids: readonly string[]; ar: number; announce: (m: string) => void }) {
  const items = useMemo(() => ids.map((id) => store.item(targetKey, id)).filter((i): i is InkItem => !!i && isInkStroke(i)), [ids, store, targetKey]);
  const page = store.page(targetKey);
  const area = useMemo(() => {
    const lines = writtenLines(items.filter(isInkStroke), ar);
    const x0 = Math.min(...lines.map((l) => l.box.x));
    const x1 = Math.max(...lines.map((l) => l.box.x + l.box.w));
    return { w: Number.isFinite(x1 - x0) ? x1 - x0 : 0.5, lines: lines.length };
  }, [items, ar]);
  const [width, setWidth] = useState(0.6);
  const [phase, setPhase] = useState<{ kind: 'idle' } | { kind: 'reading' } | { kind: 'read'; lines: Array<{ words: Array<{ text: string }> }>; dir: 'rtl' | 'ltr' } | { kind: 'error'; message: string }>({ kind: 'idle' });
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  if (!open) return null;
  const read = async () => {
    setPhase({ kind: 'reading' });
    abort.current = new AbortController();
    try {
      const xs = items.flatMap((i) => (isInkStroke(i) ? i.data.points.map((p) => p[0]) : []));
      const ys = items.flatMap((i) => (isInkStroke(i) ? i.data.points.map((p) => p[1]) : []));
      const bbox = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      const r = await readForReflow({ items, anchor: page?.anchor ?? null, bbox, ar, signal: abort.current.signal });
      setPhase({ kind: 'read', lines: r.lines, dir: r.lang === 'en' ? 'ltr' : 'rtl' });
    } catch (e) {
      setPhase({ kind: 'error', message: e instanceof Error && e.message ? e.message : 'تعذّرت قراءة الكتابة؛ لم يتغير شيء.' });
    }
  };
  // the preview (counts) is planned at time 0; «طبّق» plans again with the time of the edit
  const planAt = (now: number) => (phase.kind === 'read' ? reflowPlan(items, phase.lines, { width: area.w * width, dir: phase.dir, targetKey, ar, now, movable: (it) => store.isEditable(it) && !it.locked }) : null);
  const plan = planAt(0);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="أعد ترتيب الكلمات"
      size="sm"
      description="تُقرأ الكتابة أولًا (قراءة مشتقة على الخادم) لتُعرف الفراغات بين الكلمات، ثم تُنقل كل كلمة كاملة إلى سطرها الجديد — لا يتغير شكل أي حرف. خطوة تراجع واحدة."
      footer={
        <>
          <Button variant="plain" onClick={onClose}>
            إلغاء
          </Button>
          {phase.kind !== 'read' ? (
            <Button onClick={() => void read()} disabled={phase.kind === 'reading' || items.length === 0}>
              {phase.kind === 'reading' ? 'تُقرأ الكتابة…' : 'اقرأ الكلمات'}
            </Button>
          ) : (
            <Button
              disabled={!plan?.ok}
              onClick={() => {
                const now = planAt(nowMs());
                if (!now?.ok) return;
                store.commit('إعادة ترتيب الكلمات', now.changes);
                announce(`أُعيد ترتيب ${now.words.toLocaleString('ar-EG')} كلمة في ${now.lines.toLocaleString('ar-EG')} أسطر — يمكنك التراجع.`);
                onClose();
              }}
            >
              طبّق
            </Button>
          )}
        </>
      }
    >
      <div className="ml-ink-options" dir="rtl">
        <label className="ml-field__label" htmlFor="ink-reflow-width">
          عرض السطر الجديد: {Math.round(width * 100).toLocaleString('ar-EG')}٪ من عرض الكتابة الآن
        </label>
        <input id="ink-reflow-width" type="range" min={30} max={150} step={5} value={Math.round(width * 100)} onChange={(e) => setWidth(Number(e.target.value) / 100)} aria-valuetext={`${Math.round(width * 100)}٪`} />
        {phase.kind === 'error' && <p role="alert">{phase.message}</p>}
        {plan && (plan.ok ? <p role="status">{`${plan.words.toLocaleString('ar-EG')} كلمة في ${plan.lines.toLocaleString('ar-EG')} أسطر (${phase.kind === 'read' && phase.dir === 'rtl' ? 'من اليمين إلى اليسار' : 'من اليسار إلى اليمين'}).`}</p> : <p role="alert">{plan.reason_ar}</p>)}
      </div>
    </Dialog>
  );
}
