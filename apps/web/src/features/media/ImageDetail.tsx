// /media/images/:imageId — one image (§32): its origin badge, caption and page, the owner's classification, and
// non-destructive overlays drawn on the original geometry (highlight, arrow, occlusion mask, label point) with a
// certainty label. Drawing works with a pointer (drag) and every overlay's geometry can also be edited as numbers
// (keyboard access). «اختبر نفسك» starts an Image Quiz from the masks whose labels are certain (AC-08).
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { BookOpen, Eye, EyeOff, GraduationCap, Save, Trash2 } from 'lucide-react';
import {
  AGE_GROUPS,
  AGE_GROUP_LABELS_AR,
  IMAGE_KINDS,
  IMAGE_KIND_LABELS_AR,
  OVERLAY_CERTAINTIES,
  OVERLAY_CERTAINTY_LABELS_AR,
  OVERLAY_KIND_LABELS_AR,
  type ImageDetailView,
  type OverlayCertainty,
  type OverlayKind,
  type OverlayShape,
  type OverlayView,
} from '@medlevo/shared';
import { Breadcrumbs, Button, ErrorState, IconButton, LoadingState, SegmentedControl, Select, StatusPill, TextField, buttonClass } from '../../design';
import { errorMessage } from '../../lib/api';
import { usePageTitle } from '../../lib/usePageTitle';
import { BidiText } from '../evidence';
import { mediaApi } from './api';
import { fitRect, ORIGIN_TONE, rectFromPoints, round, studyUrl, toNormalized } from './model';
import './media.css';

type Tool = 'none' | OverlayKind;
interface Pending {
  kind: OverlayKind;
  shape: OverlayShape;
}

/** SVG overlay layer in normalized space (0..100), drawn over the image; masks are opaque. */
export function OverlayLayer({ overlays, pending, highlightId }: { overlays: Array<Pick<OverlayView, 'id' | 'kind' | 'shape' | 'label'>>; pending?: Pending | null; highlightId?: string | null }) {
  const all = [...overlays, ...(pending ? [{ id: '__pending', kind: pending.kind, shape: pending.shape, label: null }] : [])];
  return (
    <svg className="md-layer" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <marker id="md-arrowhead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="md-layer__head" />
        </marker>
      </defs>
      {all.map((o) => {
        const cls = `md-layer__${o.kind}${o.id === highlightId ? ' md-layer--focus' : ''}${o.id === '__pending' ? ' md-layer--pending' : ''}`;
        if (o.shape.type === 'rect') return <rect key={o.id} className={cls} x={o.shape.x * 100} y={o.shape.y * 100} width={o.shape.w * 100} height={o.shape.h * 100} vectorEffect="non-scaling-stroke" />;
        if (o.shape.type === 'arrow')
          return <line key={o.id} className={cls} x1={o.shape.x1 * 100} y1={o.shape.y1 * 100} x2={o.shape.x2 * 100} y2={o.shape.y2 * 100} markerEnd="url(#md-arrowhead)" vectorEffect="non-scaling-stroke" />;
        return <circle key={o.id} className={cls} cx={o.shape.x * 100} cy={o.shape.y * 100} r={1.2} vectorEffect="non-scaling-stroke" />;
      })}
    </svg>
  );
}

// Percentages are isolated LTR so they read "30%" inside Arabic text (not "%30").
function shapeSummary(s: OverlayShape): ReactNode {
  const p = (v: number) => <bdi dir="ltr">{`${Math.round(v * 100)}%`}</bdi>;
  if (s.type === 'rect')
    return (
      <>
        من {p(s.x)}، {p(s.y)} بعرض {p(s.w)} وارتفاع {p(s.h)}
      </>
    );
  if (s.type === 'arrow')
    return (
      <>
        من {p(s.x1)}، {p(s.y1)} إلى {p(s.x2)}، {p(s.y2)}
      </>
    );
  return (
    <>
      عند {p(s.x)}، {p(s.y)}
    </>
  );
}

function OverlayForm({
  initial,
  kind,
  onSave,
  onCancel,
  busy,
}: {
  initial: { label: string; aliases: string; certainty: OverlayCertainty; shape: OverlayShape };
  kind: OverlayKind;
  onSave: (v: { label: string | null; aliases: string[]; certainty: OverlayCertainty; shape: OverlayShape }) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [label, setLabel] = useState(initial.label);
  const [aliases, setAliases] = useState(initial.aliases);
  const [certainty, setCertainty] = useState<OverlayCertainty>(initial.certainty);
  const [shape, setShape] = useState(initial.shape);
  const pct = (v: number) => String(Math.round(v * 1000) / 10);
  const num = (s: string) => Math.max(0, Math.min(100, Number(s) || 0)) / 100;
  return (
    <form
      className="md-overlay-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ label: label.trim() || null, aliases: aliases.split(/[,،]/).map((x) => x.trim()).filter(Boolean), certainty, shape: shape.type === 'rect' ? fitRect(shape) : shape });
      }}
    >
      {(kind === 'occlusion_mask' || kind === 'label' || kind === 'arrow') && (
        <TextField label={kind === 'occlusion_mask' ? 'ما يخفيه القناع (الجواب)' : 'التسمية'} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200} />
      )}
      {kind === 'occlusion_mask' && <TextField label="إجابات مقبولة أخرى (افصل بفاصلة)" value={aliases} onChange={(e) => setAliases(e.target.value)} hint="مثل المصطلح بالعربية والإنجليزية." />}
      <Select label="درجة التأكد" value={certainty} onValueChange={(v) => setCertainty(v)} options={OVERLAY_CERTAINTIES.map((c) => ({ value: c, label: OVERLAY_CERTAINTY_LABELS_AR[c] }))} hint={certainty === 'uncertain' ? 'التسمية غير المؤكدة لا تصبح جوابًا في الاختبار.' : undefined} />
      {shape.type === 'rect' && (
        <fieldset className="md-geom">
          <legend>الموضع (نسبة مئوية من الصورة)</legend>
          <TextField label="من اليسار" type="number" min={0} max={100} step={0.5} value={pct(shape.x)} onChange={(e) => setShape({ ...shape, x: num(e.target.value) })} />
          <TextField label="من الأعلى" type="number" min={0} max={100} step={0.5} value={pct(shape.y)} onChange={(e) => setShape({ ...shape, y: num(e.target.value) })} />
          <TextField label="العرض" type="number" min={0.5} max={100} step={0.5} value={pct(shape.w)} onChange={(e) => setShape({ ...shape, w: num(e.target.value) })} />
          <TextField label="الارتفاع" type="number" min={0.5} max={100} step={0.5} value={pct(shape.h)} onChange={(e) => setShape({ ...shape, h: num(e.target.value) })} />
        </fieldset>
      )}
      {shape.type === 'point' && (
        <fieldset className="md-geom">
          <legend>الموضع (نسبة مئوية من الصورة)</legend>
          <TextField label="من اليسار" type="number" min={0} max={100} step={0.5} value={pct(shape.x)} onChange={(e) => setShape({ ...shape, x: num(e.target.value) })} />
          <TextField label="من الأعلى" type="number" min={0} max={100} step={0.5} value={pct(shape.y)} onChange={(e) => setShape({ ...shape, y: num(e.target.value) })} />
        </fieldset>
      )}
      {shape.type === 'arrow' && (
        <fieldset className="md-geom">
          <legend>بداية السهم ونهايته (نسبة مئوية من الصورة)</legend>
          <TextField label="البداية من اليسار" type="number" min={0} max={100} step={0.5} value={pct(shape.x1)} onChange={(e) => setShape({ ...shape, x1: num(e.target.value) })} />
          <TextField label="البداية من الأعلى" type="number" min={0} max={100} step={0.5} value={pct(shape.y1)} onChange={(e) => setShape({ ...shape, y1: num(e.target.value) })} />
          <TextField label="النهاية من اليسار" type="number" min={0} max={100} step={0.5} value={pct(shape.x2)} onChange={(e) => setShape({ ...shape, x2: num(e.target.value) })} />
          <TextField label="النهاية من الأعلى" type="number" min={0} max={100} step={0.5} value={pct(shape.y2)} onChange={(e) => setShape({ ...shape, y2: num(e.target.value) })} />
        </fieldset>
      )}
      <div className="ml-cluster">
        <Button type="submit" variant="primary" icon={<Save size={16} />} loading={busy}>
          احفظ الطبقة
        </Button>
        <Button type="button" variant="plain" onClick={onCancel}>
          إلغاء
        </Button>
      </div>
    </form>
  );
}

export function ImageDetail() {
  const { imageId = '' } = useParams();
  const navigate = useNavigate();
  const [img, setImg] = useState<ImageDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('none');
  const [pending, setPending] = useState<Pending | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [showLayers, setShowLayers] = useState(true);
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState<{ image_kind: string; modality: string; anatomic_region: string; age_group: string; title: string } | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  usePageTitle(img?.title ?? img?.caption?.slice(0, 40) ?? 'صورة');

  const load = useCallback(async () => {
    setError(null);
    try {
      const d = await mediaApi.image(imageId);
      setImg(d);
      setMeta({ image_kind: d.image_kind, modality: d.modality ?? '', anatomic_region: d.anatomic_region ?? '', age_group: d.age_group ?? '', title: d.title ?? '' });
    } catch (e) {
      setError(errorMessage(e, 'تعذّر تحميل الصورة.'));
    }
  }, [imageId]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!img || !meta) return <LoadingState stage="جارٍ تحميل الصورة…" />;

  const run = async (fn: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      await load();
      return true;
    } catch (e) {
      setActionError(errorMessage(e, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const point = (e: ReactPointerEvent) => toNormalized(e, frame.current!.getBoundingClientRect());
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (tool === 'none' || pending) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = point(e);
    start.current = p;
    if (tool === 'label') {
      setPending({ kind: 'label', shape: { type: 'point', x: round(p.x), y: round(p.y) } });
      start.current = null;
    }
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current || tool === 'none' || tool === 'label') return;
    const p = point(e);
    setPending(
      tool === 'arrow'
        ? { kind: 'arrow', shape: { type: 'arrow', x1: round(start.current.x), y1: round(start.current.y), x2: round(p.x), y2: round(p.y) } }
        : { kind: tool, shape: rectFromPoints(start.current, p) },
    );
  };
  const onUp = () => {
    start.current = null;
  };

  const quizReady = img.quiz_ready_masks > 0;
  return (
    <div className="ml-page md-page">
      <Breadcrumbs items={[{ label: 'الصور والصوت', to: '/media' }, { label: img.title ?? 'صورة' }]} />
      <header className="ml-page__header md-head">
        <div>
          <h1 className="ml-page__title">{img.title ? <BidiText as="span" text={img.title} /> : 'صورة من المصدر'}</h1>
          <div className="ml-cluster">
            <StatusPill tone={ORIGIN_TONE[img.origin_badge]} icon={false}>
              {img.origin_label_ar}
            </StatusPill>
            <StatusPill tone="neutral" icon={false}>
              {img.image_kind_label_ar}
              {img.kind_origin === 'owner' ? ' — صنّفتها أنت' : ''}
            </StatusPill>
          </div>
        </div>
        <div className="ml-cluster">
          {img.source && img.page && !img.source.deleted && (
            <Link className={buttonClass({ variant: 'secondary' })} to={studyUrl(img.source.id, { versionId: img.version_id, pageId: img.page.id, regionId: img.region_id })}>
              <BookOpen size={16} aria-hidden="true" />
              افتح الصفحة
            </Link>
          )}
          <Button
            variant="primary"
            icon={<GraduationCap size={16} />}
            disabled={!quizReady || busy}
            aria-describedby={quizReady ? undefined : 'md-quiz-why'}
            onClick={async () => {
              setBusy(true);
              setActionError(null);
              try {
                const q = await mediaApi.createQuiz(img.id);
                navigate(`/media/quiz/${encodeURIComponent(q.id)}`);
              } catch (e) {
                setActionError(errorMessage(e, 'تعذّر بدء الاختبار.'));
              } finally {
                setBusy(false);
              }
            }}
          >
            اختبر نفسك على هذه الصورة
          </Button>
        </div>
      </header>
      {!quizReady && (
        <p id="md-quiz-why" className="md-muted">
          لبدء اختبار الصورة أضف «قناع إخفاء» عليه تسمية مؤكدة (التسميات غير المؤكدة لا تصبح أجوبة).
        </p>
      )}
      {img.caption && (
        <figure className="md-caption">
          <figcaption>
            <span className="md-muted">تعليق المصدر: </span>
            <BidiText as="span" text={img.caption} />
            {img.source && (
              <span className="md-muted">
                {' '}
                — <BidiText as="span" text={[img.source.title, img.page?.label_ar].filter(Boolean).join('، ')} />
              </span>
            )}
          </figcaption>
        </figure>
      )}
      {img.notes_ar.map((n) => (
        <p key={n} className="md-muted">
          {n}
        </p>
      ))}
      {actionError && <ErrorState inline message={actionError} />}

      <div className="md-detail">
        <div className="md-detail__image">
          <div className="md-toolbar">
            <SegmentedControl
              label="أداة الرسم"
              value={tool}
              onValueChange={(v) => {
                setTool(v);
                setPending(null);
              }}
              options={[
                { value: 'none', label: 'عرض' },
                { value: 'highlight', label: OVERLAY_KIND_LABELS_AR.highlight },
                { value: 'arrow', label: OVERLAY_KIND_LABELS_AR.arrow },
                { value: 'occlusion_mask', label: 'قناع' },
                { value: 'label', label: OVERLAY_KIND_LABELS_AR.label },
              ]}
            />
            <IconButton label={showLayers ? 'أخفِ الطبقات (الصورة الأصلية)' : 'أظهر الطبقات'} pressed={!showLayers} icon={showLayers ? <EyeOff size={18} /> : <Eye size={18} />} onClick={() => setShowLayers((v) => !v)} />
          </div>
          {tool !== 'none' && !pending && (
            <div className="ml-cluster">
              <p className="md-muted">{tool === 'label' ? 'انقر على موضع التسمية في الصورة.' : 'اسحب على الصورة لرسم الطبقة.'}</p>
              {/* keyboard / no-pointer path: place the layer at the centre, then set its position as numbers */}
              <Button
                size="sm"
                variant="plain"
                onClick={() =>
                  setPending(
                    tool === 'label'
                      ? { kind: 'label', shape: { type: 'point', x: 0.5, y: 0.5 } }
                      : tool === 'arrow'
                        ? { kind: 'arrow', shape: { type: 'arrow', x1: 0.35, y1: 0.35, x2: 0.5, y2: 0.5 } }
                        : { kind: tool, shape: { type: 'rect', x: 0.4, y: 0.4, w: 0.2, h: 0.2 } },
                  )
                }
              >
                أضفها في وسط الصورة ثم حدّد موضعها بالأرقام
              </Button>
            </div>
          )}
          <div
            ref={frame}
            className={`md-frame${tool !== 'none' ? ' md-frame--drawing' : ''}`}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          >
            {img.file_url && <img src={img.file_url} alt={img.caption ? `الصورة: ${img.caption.slice(0, 160)}` : 'الصورة الأصلية'} draggable={false} />}
            {showLayers && <OverlayLayer overlays={img.overlays} pending={pending} highlightId={editing} />}
            {showLayers &&
              img.overlays
                .filter((o) => o.label && o.kind !== 'occlusion_mask')
                .map((o) => {
                  const at = o.shape.type === 'rect' ? { x: o.shape.x, y: o.shape.y } : o.shape.type === 'arrow' ? { x: o.shape.x1, y: o.shape.y1 } : { x: o.shape.x, y: o.shape.y };
                  return (
                    <span key={o.id} className="md-tag" style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%` }}>
                      <BidiText as="span" text={o.label!} />
                    </span>
                  );
                })}
          </div>
          {pending && (
            <div className="md-panel">
              <h2 className="md-section__title">طبقة جديدة: {OVERLAY_KIND_LABELS_AR[pending.kind]}</h2>
              <OverlayForm
                kind={pending.kind}
                initial={{ label: '', aliases: '', certainty: 'owner', shape: pending.shape }}
                busy={busy}
                onCancel={() => setPending(null)}
                onSave={async (v) => {
                  if (await run(() => mediaApi.addOverlay(img.id, { kind: pending.kind, shape: v.shape, label: v.label, aliases: v.aliases, certainty: v.certainty }), 'تعذّر حفظ الطبقة.')) setPending(null);
                }}
              />
            </div>
          )}
        </div>

        <div className="md-detail__side">
          <section aria-labelledby="md-ov-h">
            <h2 id="md-ov-h" className="md-section__title">
              الطبقات
            </h2>
            {img.overlays.length === 0 ? (
              <p className="md-muted">لا طبقات بعد. اختر أداة ثم ارسم على الصورة؛ الصورة الأصلية لا تتغير.</p>
            ) : (
              <ul className="md-overlays">
                {img.overlays.map((o) => (
                  <li key={o.id} className="md-overlay">
                    <div className="md-overlay__head">
                      <span className="md-overlay__kind">{o.kind_label_ar}</span>
                      {o.label ? <BidiText as="span" text={o.label} /> : <span className="md-muted">بلا تسمية</span>}
                      <StatusPill tone={o.certainty === 'uncertain' ? 'warning' : 'neutral'} icon={false}>
                        {o.certainty_label_ar}
                      </StatusPill>
                    </div>
                    <p className="md-muted">{shapeSummary(o.shape)}</p>
                    {o.kind === 'occlusion_mask' && <p className="md-muted">{o.quiz_eligible ? 'تُستخدم في الاختبار.' : o.quiz_ineligible_reason_ar}</p>}
                    {editing === o.id ? (
                      <OverlayForm
                        kind={o.kind}
                        initial={{ label: o.label ?? '', aliases: o.aliases.join('، '), certainty: o.certainty, shape: o.shape }}
                        busy={busy}
                        onCancel={() => setEditing(null)}
                        onSave={async (v) => {
                          if (await run(() => mediaApi.patchOverlay(o.id, { base_rev: o.rev, label: v.label, aliases: v.aliases, certainty: v.certainty, shape: v.shape }), 'تعذّر تعديل الطبقة.')) setEditing(null);
                        }}
                      />
                    ) : (
                      <div className="ml-cluster">
                        <Button size="sm" variant="plain" onClick={() => setEditing(o.id)}>
                          عدّل
                        </Button>
                        <IconButton size="sm" label={`أزل الطبقة ${o.label ?? o.kind_label_ar}`} icon={<Trash2 size={16} />} onClick={() => void run(() => mediaApi.deleteOverlay(o.id), 'تعذّر إزالة الطبقة.')} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="md-meta-h" className="md-section">
            <h2 id="md-meta-h" className="md-section__title">
              تصنيفك للصورة
            </h2>
            <p className="md-muted">لا يُخمَّن نوع الصورة؛ ما تحدده هنا يظهر موسومًا بأنه تصنيفك، ويستخدمه البحث عن مثال مطابق.</p>
            <form
              className="md-meta"
              onSubmit={(e) => {
                e.preventDefault();
                void run(
                  () =>
                    mediaApi.patchMeta(img.id, {
                      image_kind: meta.image_kind || null,
                      title: meta.title.trim() || null,
                      modality: meta.modality.trim() || null,
                      anatomic_region: meta.anatomic_region.trim() || null,
                      age_group: meta.age_group || null,
                    }),
                  'تعذّر حفظ التصنيف.',
                );
              }}
            >
              <TextField label="عنوان" value={meta.title} onChange={(e) => setMeta({ ...meta, title: e.target.value })} />
              <Select label="النوع" value={meta.image_kind} onValueChange={(v) => setMeta({ ...meta, image_kind: v })} options={IMAGE_KINDS.map((k) => ({ value: k, label: IMAGE_KIND_LABELS_AR[k] }))} />
              <TextField label="نوع التصوير (modality)" value={meta.modality} onChange={(e) => setMeta({ ...meta, modality: e.target.value })} placeholder="X-ray / CT / H&E" />
              <TextField label="المنطقة التشريحية" value={meta.anatomic_region} onChange={(e) => setMeta({ ...meta, anatomic_region: e.target.value })} />
              <Select label="الفئة العمرية" value={meta.age_group} onValueChange={(v) => setMeta({ ...meta, age_group: v })} options={[{ value: '', label: 'غير محددة' }, ...AGE_GROUPS.map((a) => ({ value: a, label: AGE_GROUP_LABELS_AR[a] }))]} />
              <Button type="submit" variant="secondary" loading={busy}>
                احفظ التصنيف
              </Button>
            </form>
          </section>
        </div>
      </div>
    </div>
  );
}
