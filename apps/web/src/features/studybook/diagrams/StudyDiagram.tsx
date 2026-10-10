// Interactive timeline / flowchart (§31, track F3) — a RE-ORGANIZED study diagram, never a source figure:
//  * the label «مخطط أُعيد تنظيمه تعليميًا من مصادرك — ليس صورة من المصدر» is always shown with the scope;
//  * nodes are real <button>s (44 px targets) with one roving tab stop (↓ next step, ↑ previous step, ←/→ same row —
//    RTL-aware, Home / End), Enter / Space selects, Escape clears; the edges are a decorative SVG layer behind them
//    (aria-hidden) — the selected node's relations are drawn in the accent, the others as a neutral hairline, a relation
//    or step that still needs review is DASHED and says «يحتاج مراجعة» in words (never colour alone);
//  * the details panel (aria-live) shows the step's verified statement with its citation chips (Evidence Peek → open
//    the source → back), and every relation in words with its direction «من … إلى …» (AC-08);
//  * the text twin carries exactly the same steps, relations, statements and chips.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { GitBranch, List, Shapes } from 'lucide-react';
import { DIAGRAM_NODE_KIND_LABELS_AR, type ClaimView, type StudyDiagramEdgeView, type StudyDiagramNodeView, type StudyDiagramView } from '@medlevo/shared';
import { SegmentedControl, StatusPill, cx, isRtl } from '../../../design';
import { BidiText, CitationChip } from '../../evidence';
import { edgeSentence, layoutDiagram, moveFocus, moveForKey, nodeName, NODE_H_PX } from './layout';
import './diagrams.css';

type View = 'map' | 'list';

function Chips({ ids, claims }: { ids: string[]; claims: Record<string, ClaimView> }) {
  const cits = ids.flatMap((id) => claims[id]?.citations ?? []);
  if (cits.length === 0) return null;
  return (
    <span className="dg-chips">
      {cits.map((c, i) => (
        <CitationChip key={`${c.evidence.id}-${i}`} evidence={c.evidence} />
      ))}
    </span>
  );
}

function Verification({ v }: { v: 'linked' | 'needs_review' }) {
  return v === 'linked' ? (
    <StatusPill tone="success">مرتبط بدليل</StatusPill>
  ) : (
    <StatusPill tone="warning">يحتاج مراجعة</StatusPill>
  );
}

export function StudyDiagram({ diagram, initialView = 'map' }: { diagram: StudyDiagramView; initialView?: View }) {
  const [view, setView] = useState<View>(initialView);
  const label = (key: string) => diagram.nodes.find((n) => n.key === key)?.label ?? key;
  return (
    <section className="dg" aria-label={`${diagram.kind_label_ar}: ${diagram.title}`}>
      <header className="dg-head">
        <p className="dg-kind">
          <Shapes size={16} aria-hidden="true" /> {diagram.kind_label_ar}
        </p>
        <h4 className="dg-title">
          <BidiText text={diagram.title} />
        </h4>
        <p className="dg-label" role="note">
          {diagram.label_ar}
        </p>
        <p className="dg-muted">{`النطاق: ${diagram.scope_describe_ar}`}</p>
        {diagram.stale_reason_ar && (
          <p className="dg-stale" role="note">
            {diagram.stale_reason_ar}
          </p>
        )}
      </header>
      <SegmentedControl<View>
        label="طريقة عرض المخطط"
        options={[
          { value: 'map', label: 'المخطط', icon: <GitBranch size={16} /> },
          { value: 'list', label: 'النص المكافئ', icon: <List size={16} /> },
        ]}
        value={view}
        onValueChange={setView}
        size="sm"
        fullWidth
      />
      {view === 'map' ? <DiagramCanvas diagram={diagram} /> : <DiagramText diagram={diagram} label={label} />}
      {diagram.removed.length > 0 && (
        <details className="dg-removed">
          <summary>{`أُزيل ${diagram.removed.length === 1 ? 'جزء واحد' : `${diagram.removed.length} أجزاء`} لم تجتز التحقق (لا تُعرض كمدعومة)`}</summary>
          <ul>
            {diagram.removed.map((r, i) => (
              <li key={i}>
                <BidiText text={r.text} /> — <span className="dg-muted">{r.reason_ar}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function DiagramText({ diagram, label }: { diagram: StudyDiagramView; label: (k: string) => string }) {
  const layout = useMemo(() => layoutDiagram(diagram.kind, diagram.nodes, diagram.edges, false), [diagram]);
  const ordered = layout.layers.flat().map((k) => diagram.nodes.find((n) => n.key === k)!);
  return (
    <div className="dg-text">
      <ol className="dg-steps">
        {ordered.map((n) => (
          <li key={n.key} className="dg-step">
            <p className="dg-step__head">
              <span className="dg-step__kind">{DIAGRAM_NODE_KIND_LABELS_AR[n.kind]}</span>
              {n.time_label && <BidiText className="dg-step__time" text={n.time_label} />}
              <BidiText className="dg-step__label" text={n.label} />
              <Verification v={n.verification} />
            </p>
            <p className="dg-step__statement">
              <BidiText text={n.statement} /> <Chips ids={n.claim_ids} claims={diagram.claims} />
            </p>
          </li>
        ))}
      </ol>
      {diagram.edges.length > 0 && (
        <>
          <h5 className="dg-subhead">العلاقات (الاتجاه من … إلى …)</h5>
          <ul className="dg-edges-list">
            {diagram.edges.map((e) => (
              <li key={`${e.from}-${e.to}`}>
                <BidiText text={edgeSentence(e, label)} /> <Verification v={e.verification} />
                <p className="dg-step__statement">
                  <BidiText text={e.statement} /> <Chips ids={e.claim_ids} claims={diagram.claims} />
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function DiagramCanvas({ diagram }: { diagram: StudyDiagramView }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  const [rtl, setRtl] = useState(true);
  const [focus, setFocus] = useState<string>(() => diagram.nodes[0]?.key ?? '');
  const [selected, setSelected] = useState<string | null>(null);
  const layout = useMemo(() => layoutDiagram(diagram.kind, diagram.nodes, diagram.edges, rtl), [diagram, rtl]);
  const byKey = useMemo(() => new Map(diagram.nodes.map((n) => [n.key, n])), [diagram]);
  const label = (key: string) => byKey.get(key)?.label ?? key;

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    setRtl(isRtl(el));
    const measure = () => setWidth(Math.max(200, el.clientWidth));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!byKey.has(focus)) setFocus(diagram.nodes[0]?.key ?? '');
  }, [byKey, focus, diagram.nodes]);

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, key: string) => {
    if (e.key === 'Escape') {
      setSelected(null);
      return;
    }
    const move = moveForKey(e.key, rtl);
    if (!move) return;
    e.preventDefault();
    const next = moveFocus(layout, diagram.edges, key, move);
    setFocus(next);
    wrap.current?.querySelector<HTMLButtonElement>(`[data-node="${CSS.escape(next)}"]`)?.focus();
  };

  const rowWidthPct = (key: string) => {
    const p = layout.nodes.get(key)!;
    const n = layout.layers[p.layer]!.length;
    return Math.min(46, 92 / n);
  };
  const px = (pct: number) => (pct / 100) * width;
  const sel = selected ? byKey.get(selected) : null;
  const related = (e: StudyDiagramEdgeView) => !!selected && (e.from === selected || e.to === selected);

  return (
    <div className="dg-canvas-wrap">
      <div ref={wrap} className="dg-canvas" style={{ height: layout.heightPx }} role="group" aria-label={`${diagram.kind_label_ar}: ${diagram.title} — ${diagram.nodes.length} عقد. الأسهم: ↓ الخطوة التالية، ↑ السابقة، ← → في الصف نفسه، Enter لعرض التفاصيل.`}>
        <svg className="dg-edges" width={width} height={layout.heightPx} viewBox={`0 0 ${width} ${layout.heightPx}`} aria-hidden="true" focusable="false">
          <defs>
            <marker id={`dg-arrow-${diagram.id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" className="dg-arrowhead" />
            </marker>
            <marker id={`dg-arrow-on-${diagram.id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" className="dg-arrowhead dg-arrowhead--on" />
            </marker>
          </defs>
          {diagram.edges.map((e) => {
            const a = layout.nodes.get(e.from);
            const b = layout.nodes.get(e.to);
            if (!a || !b) return null;
            const x1 = px(a.xPct);
            const x2 = px(b.xPct);
            const down = b.layer > a.layer;
            const y1 = down ? a.yPx + NODE_H_PX : a.yPx + NODE_H_PX / 2;
            const y2 = down ? b.yPx - 2 : b.yPx + NODE_H_PX / 2;
            const side = rtl ? -1 : 1;
            const d = down
              ? `M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`
              : `M${x1 + side * 40},${y1} C${x1 + side * 90},${y1} ${x2 + side * 90},${y2} ${x2 + side * 40},${y2}`;
            const on = related(e);
            return (
              <path
                key={`${e.from}-${e.to}`}
                d={d}
                className={cx('dg-edge', on && 'dg-edge--on', e.verification !== 'linked' && 'dg-edge--review')}
                markerEnd={`url(#dg-arrow${on ? '-on' : ''}-${diagram.id})`}
              />
            );
          })}
        </svg>
        {diagram.edges
          .filter((e) => e.label)
          .map((e) => {
            const a = layout.nodes.get(e.from);
            const b = layout.nodes.get(e.to);
            if (!a || !b || b.layer <= a.layer) return null;
            const x = (a.xPct + b.xPct) / 2;
            const y = (a.yPx + NODE_H_PX + b.yPx) / 2 - 10;
            return (
              <span key={`l-${e.from}-${e.to}`} className="dg-edge-label" style={{ left: `${x}%`, top: y }} title={e.label ?? undefined} aria-hidden="true">
                {(e.label ?? '').length > 22 ? `${e.label!.slice(0, 21)}…` : e.label}
              </span>
            );
          })}
        {diagram.nodes.map((n) => {
          const p = layout.nodes.get(n.key);
          if (!p) return null;
          const w = rowWidthPct(n.key);
          return (
            <button
              key={n.key}
              type="button"
              data-node={n.key}
              className={cx('dg-node', `dg-node--${n.kind}`, n.verification !== 'linked' && 'dg-node--review', selected === n.key && 'dg-node--on')}
              style={{ left: `${p.xPct - w / 2}%`, width: `${w}%`, top: p.yPx, minHeight: NODE_H_PX }}
              tabIndex={focus === n.key ? 0 : -1}
              aria-pressed={selected === n.key}
              aria-label={nodeName(n, diagram.edges)}
              onFocus={() => setFocus(n.key)}
              onClick={() => setSelected((s) => (s === n.key ? null : n.key))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setSelected((s) => (s === n.key ? null : n.key));
                  return;
                }
                onKey(e, n.key);
              }}
            >
              {n.time_label && <span className="dg-node__time">{n.time_label}</span>}
              <span className="dg-node__label">{n.label}</span>
              <span className="dg-node__kind">
                {DIAGRAM_NODE_KIND_LABELS_AR[n.kind]}
                {n.verification !== 'linked' ? ' · يحتاج مراجعة' : ''}
              </span>
            </button>
          );
        })}
      </div>
      <div className="dg-details" role="region" aria-label="تفاصيل الخطوة المختارة" aria-live="polite">
        {sel ? <NodeDetails node={sel} diagram={diagram} label={label} /> : <p className="dg-muted">اختر خطوة في المخطط لترى عبارتها المتحقق منها وأدلتها وعلاقاتها.</p>}
      </div>
    </div>
  );
}

function NodeDetails({ node, diagram, label }: { node: StudyDiagramNodeView; diagram: StudyDiagramView; label: (k: string) => string }) {
  const rel = diagram.edges.filter((e) => e.from === node.key || e.to === node.key);
  return (
    <div className="dg-detail">
      <p className="dg-step__head">
        <span className="dg-step__kind">{DIAGRAM_NODE_KIND_LABELS_AR[node.kind]}</span>
        <BidiText className="dg-step__label" text={node.label} />
        <Verification v={node.verification} />
      </p>
      <p className="dg-step__statement">
        <BidiText text={node.statement} /> <Chips ids={node.claim_ids} claims={diagram.claims} />
      </p>
      {rel.length > 0 && (
        <ul className="dg-edges-list">
          {rel.map((e) => (
            <li key={`${e.from}-${e.to}`}>
              <BidiText text={edgeSentence(e, label)} /> <Chips ids={e.claim_ids} claims={diagram.claims} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
