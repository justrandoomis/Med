// Knowledge map (§31, §16): lectures ↔ concepts ↔ questions — an INTERACTIVE, keyboard-accessible graph with a
// text / list twin that carries exactly the same information.
//  * nodes are real <button>s (44px targets) in three columns; identity by column + icon + shape + words, never colour;
//    one roving tab stop: ↑/↓ inside a column, ←/→ to the linked node of the adjacent column (RTL-aware), Home/End,
//    Enter/Space selects (details panel, aria-live), Escape clears;
//  * edges are drawn in the «emphasis» form (dataviz): the selected node's links in the accent, the rest in a neutral
//    hairline — validated: both ≥ 3:1 against paper in light and dark, CVD ΔE ≥ 16 between them; an inferred relation is
//    also dashed AND says «مستنتجة» in words;
//  * every element links back to its page or question; the map is a study regrouping, not a figure of the source.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, CircleDot, FileQuestion, Map as MapIcon, List } from 'lucide-react';
import type { KnowledgeMapEdge, KnowledgeMapNode, KnowledgeMapResponse } from '@medlevo/shared';
import { Button, SegmentedControl, cx, isRtl, navKeyFor } from '../../design';
import { BidiText } from '../evidence';
import {
  COLUMN_BOX,
  COLUMN_TITLES_AR,
  NODE_PX,
  NODE_TYPE_AR,
  NOUNS,
  countAr,
  edgesOf,
  layoutMap,
  moveFocus,
  neighbours,
  nodeAccessibleName,
  physX,
  rowY,
  type MapMove,
  type PlacedNode,
} from './model';

type View = 'map' | 'list';

function wideScreen(): boolean {
  try {
    return window.matchMedia('(min-width: 48rem)').matches;
  } catch {
    return true;
  }
}

const NODE_ICON: Record<KnowledgeMapNode['type'], typeof BookOpen> = { lecture: BookOpen, concept: CircleDot, question: FileQuestion };

/** Reader link of a lecture page («lecture:<id>» node + page id). */
function pageHref(lectureNodeId: string, pageId: string): string {
  const id = lectureNodeId.replace(/^lecture:/, '');
  return `/study/${encodeURIComponent(id)}?page_id=${encodeURIComponent(pageId)}`;
}

export function KnowledgeGraph({ data, initialView }: { data: KnowledgeMapResponse; initialView?: View }) {
  const [view, setView] = useState<View>(() => initialView ?? (wideScreen() ? 'map' : 'list'));
  const layout = useMemo(() => layoutMap(data), [data]);
  const counts = { lecture: layout.columns[0]!.length, concept: layout.columns[1]!.length, question: layout.columns[2]!.length };

  return (
    <div className="kb-graph-wrap">
      <div className="kb-graph-tools">
        <SegmentedControl<View>
          label="طريقة عرض الخريطة"
          options={[
            { value: 'map', label: 'الخريطة', icon: <MapIcon size={16} /> },
            { value: 'list', label: 'القائمة النصية', icon: <List size={16} /> },
          ]}
          value={view}
          onValueChange={setView}
          size="sm"
        />
        <p className="lw-muted">
          {countAr(counts.lecture, NOUNS.lecture)} · المفاهيم المعروضة {counts.concept} من {data.truncated.concepts.total} · الأسئلة المعروضة {counts.question} من {data.truncated.questions.total}
        </p>
      </div>
      {layout.nodes.length === 0 ? (
        <p className="lw-muted">لا شيء على الخريطة بعد: تظهر هنا المحاضرات ومفاهيمها وأسئلتها بعد معالجة المحاضرات واستخراج هيكلها.</p>
      ) : view === 'map' ? (
        <MapView data={data} />
      ) : (
        <TextTwin data={data} />
      )}
      <ul className="kb-notes">
        {data.notes_ar.map((n) => (
          <li key={n} className="lw-muted">
            {n}
          </li>
        ))}
      </ul>
    </div>
  );
}

function MapView({ data }: { data: KnowledgeMapResponse }) {
  const layout = useMemo(() => layoutMap(data), [data]);
  const groupRef = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [focused, setFocused] = useState<string | null>(layout.nodes[0]?.id ?? null);
  const [selected, setSelected] = useState<string | null>(null);
  const [rtl, setRtl] = useState(true);
  const moved = useRef(false);
  useEffect(() => setRtl(isRtl(groupRef.current)), []);
  useEffect(() => {
    if (focused && !layout.byId.has(focused)) setFocused(layout.nodes[0]?.id ?? null);
    if (selected && !layout.byId.has(selected)) setSelected(null);
  }, [layout, focused, selected]);
  const scrollerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moved.current || !focused) return;
    moved.current = false;
    const el = buttons.current.get(focused);
    if (!el) return;
    // focus without the browser's own scroll (it also pans the page / visual viewport on phones), then reveal the node
    // inside the map's own horizontal scroller and, if needed, the window — nothing else moves
    el.focus({ preventScroll: true });
    revealNode(el, scrollerRef.current);
  }, [focused]);

  const linked = useMemo(() => (selected ? neighbours(data.edges, selected) : new Set<string>()), [data.edges, selected]);
  const linkCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of data.edges) {
      m.set(e.from, (m.get(e.from) ?? 0) + 1);
      m.set(e.to, (m.get(e.to) ?? 0) + 1);
    }
    return m;
  }, [data.edges]);

  const go = (move: MapMove) => {
    const next = moveFocus(layout, data.edges, focused, move);
    if (next) {
      moved.current = true;
      setFocused(next);
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    let move: MapMove | null = null;
    if (e.key === 'ArrowUp') move = 'up';
    else if (e.key === 'ArrowDown') move = 'down';
    else if (e.key === 'Home') move = 'first';
    else if (e.key === 'End') move = 'last';
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const step = navKeyFor(e.key, { rtl, orientation: 'horizontal' });
      move = step === 'next' ? 'next' : step === 'prev' ? 'prev' : null;
    } else if (e.key === 'Escape' && selected) {
      e.preventDefault();
      setSelected(null);
      return;
    }
    if (!move) return;
    e.preventDefault();
    go(move);
  };
  const focusNode = (id: string) => {
    moved.current = true;
    setFocused(id);
    setSelected(id);
  };

  const sel = selected ? layout.byId.get(selected) ?? null : null;
  const instructionsId = 'kb-map-help';
  return (
    <div className="kb-map-layout">
      <div className="kb-scroll" ref={scrollerRef}>
        <div className="kb-columns-head" aria-hidden="true">
          {COLUMN_TITLES_AR.map((t, i) => (
            <span key={t} className="kb-colhead" style={{ insetInlineStart: `${COLUMN_BOX[i as 0 | 1 | 2].start}%`, width: `${COLUMN_BOX[i as 0 | 1 | 2].end - COLUMN_BOX[i as 0 | 1 | 2].start}%` }}>
              {t}
            </span>
          ))}
        </div>
        <div
          ref={groupRef}
          className={cx('kb-map', selected && 'kb-map--has-selection')}
          role="group"
          aria-label={`خريطة المعرفة: ${countAr(layout.columns[0]!.length, NOUNS.lecture)}، ${countAr(layout.columns[1]!.length, NOUNS.concept)}، ${countAr(layout.columns[2]!.length, NOUNS.question)}`}
          aria-describedby={instructionsId}
          style={{ height: layout.heightPx }}
          onKeyDown={onKeyDown}
        >
          <svg className="kb-edges" viewBox={`0 0 100 ${layout.heightPx}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
            {data.edges.map((e) => (
              <EdgePath key={e.id} edge={e} a={layout.byId.get(e.from)} b={layout.byId.get(e.to)} rtl={rtl} active={!!selected && (e.from === selected || e.to === selected)} dim={!!selected && e.from !== selected && e.to !== selected} />
            ))}
          </svg>
          {layout.nodes.map((n) => {
            const Icon = NODE_ICON[n.type];
            const box = COLUMN_BOX[n.col];
            return (
              <button
                key={n.id}
                ref={(el) => {
                  if (el) buttons.current.set(n.id, el);
                  else buttons.current.delete(n.id);
                }}
                type="button"
                className={cx('kb-node', `kb-node--${n.type}`, n.status === 'suggested' && 'kb-node--suggested', selected === n.id && 'kb-node--selected', linked.has(n.id) && 'kb-node--linked')}
                style={{ insetInlineStart: `${box.start}%`, width: `${box.end - box.start}%`, top: n.row * 56, height: NODE_PX }}
                tabIndex={focused === n.id ? 0 : -1}
                aria-pressed={selected === n.id}
                aria-label={nodeAccessibleName(n, linkCount.get(n.id) ?? 0)}
                onFocus={() => setFocused(n.id)}
                onClick={() => {
                  setFocused(n.id);
                  setSelected((s) => (s === n.id ? null : n.id));
                }}
              >
                <Icon size={16} aria-hidden="true" className="kb-node__icon" />
                {/* dir=auto: an English label is cut at ITS end («Acute Appendi…»), never at its start */}
                <span className="kb-node__label" dir="auto">
                  {n.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <p id={instructionsId} className="lw-muted kb-help">
        التنقل بلوحة المفاتيح: ↑ و↓ داخل العمود، ← و→ إلى العنصر المرتبط في العمود المجاور، Enter لعرض روابطه، Esc للإلغاء. المحاضرة بمربع، المفهوم بدائرة، السؤال بعلامة سؤال؛ الخط المتقطع علاقة مستنتجة.
      </p>
      <section className="kb-details lw-sheet" aria-live="polite" aria-label="تفاصيل العنصر المختار">
        {sel ? <NodeDetails node={sel} data={data} layout={layout} onGo={focusNode} /> : <p className="lw-muted">اختر عنصرًا في الخريطة (بالنقر أو Enter) لعرض صفحاته وروابطه.</p>}
      </section>
    </div>
  );
}

/** Bring a map node into view: the map's horizontal scroller first, then the window (vertical) — never other ancestors. */
function revealNode(el: HTMLElement, scroller: HTMLElement | null): void {
  try {
    const er = el.getBoundingClientRect();
    if (scroller) {
      const sr = scroller.getBoundingClientRect();
      if (er.left < sr.left) scroller.scrollBy({ left: er.left - sr.left - 8 });
      else if (er.right > sr.right) scroller.scrollBy({ left: er.right - sr.right + 8 });
    }
    const top = 72; // clear of the top bar
    const bottom = window.innerHeight - 88; // clear of the phone tab bar
    if (er.top < top) window.scrollBy({ top: er.top - top - 8 });
    else if (er.bottom > bottom) window.scrollBy({ top: er.bottom - bottom + 8 });
  } catch {
    // jsdom / old browsers: focus alone is enough
  }
}

function EdgePath({ edge, a, b, rtl, active, dim }: { edge: KnowledgeMapEdge; a?: PlacedNode; b?: PlacedNode; rtl: boolean; active: boolean; dim: boolean }) {
  if (!a || !b) return null;
  const cls = cx('kb-edge', `kb-edge--${edge.kind}`, edge.support === 'inferred' && 'kb-edge--inferred', active && 'kb-edge--active', dim && 'kb-edge--dim');
  if (a.col === b.col) {
    // concept ↔ concept: an arc in the gap after the column
    const x = COLUMN_BOX[a.col].end;
    const bulge = x + 4;
    const d = `M ${physX(x, rtl)} ${rowY(a.row)} C ${physX(bulge, rtl)} ${rowY(a.row)}, ${physX(bulge, rtl)} ${rowY(b.row)}, ${physX(x, rtl)} ${rowY(b.row)}`;
    return <path d={d} className={cls} vectorEffect="non-scaling-stroke" />;
  }
  const [l, r] = a.col < b.col ? [a, b] : [b, a];
  const x1 = COLUMN_BOX[l.col].end;
  const x2 = COLUMN_BOX[r.col].start;
  const xm = (x1 + x2) / 2;
  const d = `M ${physX(x1, rtl)} ${rowY(l.row)} C ${physX(xm, rtl)} ${rowY(l.row)}, ${physX(xm, rtl)} ${rowY(r.row)}, ${physX(x2, rtl)} ${rowY(r.row)}`;
  return <path d={d} className={cls} vectorEffect="non-scaling-stroke" />;
}

function NodeDetails({ node, data, layout, onGo }: { node: PlacedNode; data: KnowledgeMapResponse; layout: ReturnType<typeof layoutMap>; onGo: (id: string) => void }) {
  const edges = edgesOf(data.edges, node.id);
  return (
    <div className="lw-stack-sm">
      <h3 className="lw-sheet__title">
        <span className="lw-muted">{NODE_TYPE_AR[node.type]}:</span> <BidiText as="span" text={node.label} />
      </h3>
      {node.sublabel && <p className="lw-muted">{node.sublabel}</p>}
      {node.href && (
        <Link className="lw-link" to={node.href}>
          {node.type === 'lecture' ? 'افتح المحاضرة' : node.type === 'concept' ? 'افتح المفهوم (مواضعه وعلاقاته)' : 'افتح السؤال'}
        </Link>
      )}
      {edges.length === 0 ? (
        <p className="lw-muted">لا روابط لهذا العنصر في الخريطة.</p>
      ) : (
        <ul className="kb-links">
          {edges.map((e) => {
            const otherId = e.from === node.id ? e.to : e.from;
            const other = layout.byId.get(otherId);
            if (!other) return null;
            const lectureId = e.kind === 'mentions' ? (e.from.startsWith('lecture:') ? e.from : e.to) : e.from.startsWith('lecture:') ? e.from : e.to.startsWith('lecture:') ? e.to : null;
            return (
              <li key={e.id} className="kb-link">
                <span>
                  {e.kind === 'relation' && e.relation ? (
                    <>
                      {e.from === node.id ? '' : '← '}
                      {e.label_ar}
                      {e.from === node.id ? ' →' : ''}{' '}
                    </>
                  ) : (
                    <span className="lw-muted">{NODE_TYPE_AR[other.type]}: </span>
                  )}
                  <Button size="sm" variant="plain" onClick={() => onGo(other.id)} aria-label={`انتقل في الخريطة إلى ${NODE_TYPE_AR[other.type]}: ${other.label}`}>
                    <bdi>{other.label}</bdi>
                  </Button>
                </span>
                {e.kind !== 'relation' && <span className="lw-muted">{e.label_ar}</span>}
                {e.pages.length > 0 && lectureId && (
                  <span className="kb-pages">
                    {e.pages.map((p) => (
                      <Link key={p.page_id} className="lw-link" to={pageHref(lectureId, p.page_id)}>
                        {p.label_ar}
                      </Link>
                    ))}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** The same information as a structured text list (the WCAG-clean twin of the map). */
export function TextTwin({ data }: { data: KnowledgeMapResponse }) {
  const layout = useMemo(() => layoutMap(data), [data]);
  const node = (id: string) => layout.byId.get(id);
  const relations = data.edges.filter((e) => e.kind === 'relation');
  return (
    <div className="kb-twin">
      {layout.columns[0]!.map((l) => {
        const mentions = data.edges.filter((e) => e.kind === 'mentions' && e.from === l.id);
        return (
          <section key={l.id} className="kb-twin__lecture" aria-labelledby={`tw-${l.id}`}>
            <h3 id={`tw-${l.id}`} className="lw-sheet__subtitle">
              <BookOpen size={16} aria-hidden="true" /> <BidiText as="span" text={l.label} />
            </h3>
            {l.sublabel && <p className="lw-muted">{l.sublabel}</p>}
            {mentions.length === 0 ? (
              <p className="lw-muted">لا مفاهيم معروضة من هذه المحاضرة.</p>
            ) : (
              <ul className="kb-twin__list">
                {mentions.map((m) => {
                  const c = node(m.to);
                  if (!c) return null;
                  const qs = data.edges.filter((e) => e.kind === 'covers' && e.to === c.id).map((e) => node(e.from)).filter(Boolean) as PlacedNode[];
                  return (
                    <li key={m.id}>
                      {c.href ? (
                        <Link className="lw-link" to={c.href}>
                          <bdi>{c.label}</bdi>
                        </Link>
                      ) : (
                        <bdi>{c.label}</bdi>
                      )}{' '}
                      <span className="lw-muted">({c.sublabel})</span>{' '}
                      <span className="kb-pages">
                        {m.pages.map((p) => (
                          <Link key={p.page_id} className="lw-link" to={pageHref(l.id, p.page_id)}>
                            {p.label_ar}
                          </Link>
                        ))}
                      </span>
                      {qs.length > 0 && <span className="lw-muted"> — {qs.length === 1 ? 'سؤال واحد مرتبط' : `${qs.length} أسئلة مرتبطة`}</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
      {relations.length > 0 && (
        <section aria-labelledby="tw-rel">
          <h3 id="tw-rel" className="lw-sheet__subtitle">
            العلاقات بين المفاهيم
          </h3>
          <ul className="kb-twin__list">
            {relations.map((r) => (
              <li key={r.id}>
                <bdi>{node(r.from)?.label}</bdi> — {r.label_ar} — <bdi>{node(r.to)?.label}</bdi>
              </li>
            ))}
          </ul>
        </section>
      )}
      {layout.columns[2]!.length > 0 && (
        <section aria-labelledby="tw-q">
          <h3 id="tw-q" className="lw-sheet__subtitle">
            <FileQuestion size={16} aria-hidden="true" /> الأسئلة
          </h3>
          <ul className="kb-twin__list">
            {layout.columns[2]!.map((q) => {
              const cs = data.edges.filter((e) => e.from === q.id);
              return (
                <li key={q.id}>
                  {q.href ? (
                    <Link className="lw-link" to={q.href}>
                      <bdi>{q.label}</bdi>
                    </Link>
                  ) : (
                    <bdi>{q.label}</bdi>
                  )}{' '}
                  <span className="lw-muted">({q.sublabel})</span>
                  {cs.length > 0 && (
                    <span className="lw-muted">
                      {' '}
                      — {cs
                        .map((e) => (node(e.to) ? `${node(e.to)!.label} (${e.label_ar})` : null))
                        .filter(Boolean)
                        .join('، ')}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
