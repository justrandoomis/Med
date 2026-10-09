// Generated content view (ArtifactView, §10–§12, §24). Always labelled as generated. Every claim's runs are
// followed by its Source Chips; claims that are not linked to evidence (needs review, conflict, rejected,
// pending, unknown) are visibly marked with text + icon, never shown as supported. Sentences removed by
// verification are available on demand. An abstention shows its specific reason and, when the server
// suggests a wider scope, an explicit «وسّع النطاق» action (never applied silently, §08).
import { Fragment, useId, useMemo, useState, type ReactNode } from 'react';
import { CircleAlert, FileWarning, Lock, Sparkles } from 'lucide-react';
import {
  SCOPE_MODE_LABELS_AR,
  type ArtifactView,
  type ClaimView,
  type ContentBlockView,
  type EvidenceView,
  type Paragraph,
  type RichText,
  type Run,
  type SourceScope,
} from '@medlevo/shared';
import { Button, StatusPill, type StatusTone } from '../../design';
import { BidiText } from './BidiText';
import { CitationChip } from './CitationChip';
import { EvidenceRibbon } from './EvidenceRibbon';
import { CLAIM_MARK_LABELS_AR, claimMark, ribbonFromClaims, segmentByClaim, type ClaimMark } from './model';
import { ScopeBadge } from './Scope';
import { SourceInspector } from './SourceInspector';

const MARK_TONE: Record<Exclude<ClaimMark, 'linked'>, StatusTone> = { review: 'warning', conflict: 'danger', rejected: 'danger', pending: 'info', unknown: 'warning' };

const BLOCK_LABELS_AR: Partial<Record<ContentBlockView['kind'], string>> = {
  original_quote: 'نص أصلي من المصدر',
  clinical_note: 'ملاحظة سريرية',
  exam_pearl: 'نقطة امتحانية',
  memory_hook: 'طريقة للحفظ',
  example: 'مثال',
  mini_question: 'سؤال قصير',
  warning: 'تنبيه',
  term: 'مصطلح',
  coverage_note: 'ما غطّاه هذا الشرح',
  figure: 'شكل',
  flowchart: 'مخطط',
};

const ARTIFACT_STATUS: Partial<Record<ArtifactView['status'], { label: string; tone: StatusTone }>> = {
  draft: { label: 'مسودة — لم يكتمل التحقق', tone: 'info' },
  generating: { label: 'قيد التوليد — مسودة', tone: 'info' },
  verifying: { label: 'قيد التحقق', tone: 'info' },
  partial: { label: 'مكتمل جزئيًا', tone: 'warning' },
  stale: { label: 'قد يكون قديمًا', tone: 'warning' },
  failed: { label: 'فشل التوليد', tone: 'danger' },
  superseded: { label: 'توجد نسخة أحدث', tone: 'neutral' },
};

interface Ctx {
  claims: Record<string, ClaimView>;
  pinned: Set<string>;
  onInspect: (e: EvidenceView, claim: ClaimView) => void;
}

/** Inline marks the RichText contract allows; anything else in stored/generated content is ignored (never an element). */
const SAFE_MARKS = new Set(['b', 'i', 'u', 'sup', 'sub', 'em']);

function RunNode({ run, paraDir }: { run: Run; paraDir: 'rtl' | 'ltr' }) {
  const dir = run.dir ?? paraDir;
  let content: ReactNode = run.kind === 'code' ? <code>{run.t}</code> : run.t;
  for (const m of [...(run.marks ?? [])].reverse()) {
    if (!SAFE_MARKS.has(m)) continue;
    const Tag = m;
    content = <Tag>{content}</Tag>;
  }
  const cls = run.kind && run.kind !== 'text' ? `ml-run--${run.kind}` : undefined;
  if (dir !== paraDir) {
    return (
      <bdi dir={dir} lang={run.lang ?? (dir === 'ltr' ? 'en' : 'ar')} className={[dir === 'ltr' ? 'ml-ltr' : 'ml-rtl-island', cls].filter(Boolean).join(' ')}>
        {content}
      </bdi>
    );
  }
  return cls || run.lang ? (
    <span className={cls} lang={run.lang}>
      {content}
    </span>
  ) : (
    <>{content}</>
  );
}

function ClaimTrail({ claim, ctx, claimId }: { claim: ClaimView | undefined; ctx: Ctx; claimId: string }) {
  const mark = claimMark(claim);
  // why a claim is not linked must be reachable without hover (touch, keyboard, screen readers)
  const [showWhy, setShowWhy] = useState(false);
  const why = claim?.issues.map((i) => i.reason_ar).join(' ') || '';
  const whyId = useId();
  return (
    <span className="ev-claim__trail" data-claim-trail={claimId}>
      {claim?.citations.map((c) => {
        const ev: EvidenceView = c.evidence.availability === 'version_replaced' && ctx.pinned.has(c.evidence.version_id) ? { ...c.evidence, availability: 'available' } : c.evidence;
        return (
          <CitationChip
            key={`${c.evidence.id}-${c.relation}`}
            evidence={ev}
            context={{ support_type: claim.support_type, verification_status: claim.verification_status, relation: c.relation }}
            onInspect={(e) => ctx.onInspect(e, claim)}
          />
        );
      })}
      {mark !== 'linked' && (
        <StatusPill tone={MARK_TONE[mark]} icon={<CircleAlert size={14} />} className="ev-claim__status" title={why || undefined}>
          {CLAIM_MARK_LABELS_AR[mark]}
        </StatusPill>
      )}
      {mark !== 'linked' && why && (
        <button type="button" className="ev-claim__why" aria-expanded={showWhy} aria-controls={whyId} onClick={() => setShowWhy((v) => !v)}>
          {showWhy ? 'إخفاء السبب' : 'لماذا؟'}
        </button>
      )}
      {mark !== 'linked' && why && (
        <span id={whyId} className="ev-claim__reason" role="note" hidden={!showWhy}>
          {why}
        </span>
      )}
    </span>
  );
}

function ClaimParagraph({ p, ctx, as }: { p: Paragraph; ctx: Ctx; as?: 'p' | 'li' | 'h3' | 'h4' | 'blockquote' | 'div' }) {
  const lang = p.dir === 'rtl' ? 'ar' : 'en';
  const Tag = as ?? (p.kind === 'li' ? 'li' : p.kind === 'quote' ? 'blockquote' : p.kind === 'h' ? (p.level && p.level > 1 ? 'h4' : 'h3') : 'p');
  const segments = segmentByClaim(p);
  return (
    <Tag dir={p.dir} lang={lang} className="ev-par">
      {segments.map((s, i) => {
        const runs = s.runs.map((r, j) => <RunNode key={j} run={r} paraDir={p.dir} />);
        if (!s.claimId) return <Fragment key={i}>{runs}</Fragment>;
        const claim = ctx.claims[s.claimId];
        const mark = claimMark(claim);
        return (
          <Fragment key={i}>
            <span className={`ev-claim ev-claim--${mark}`} data-claim={s.claimId}>
              {runs}
            </span>
            <ClaimTrail claim={claim} ctx={ctx} claimId={s.claimId} />
          </Fragment>
        );
      })}
    </Tag>
  );
}

function RichBlock({ rt, ctx }: { rt: RichText; ctx: Ctx }) {
  const groups: Array<{ list: boolean; items: Paragraph[] }> = [];
  for (const p of rt.paragraphs) {
    const li = p.kind === 'li';
    const last = groups[groups.length - 1];
    if (li && last?.list) last.items.push(p);
    else groups.push({ list: li, items: [p] });
  }
  return (
    <>
      {groups.map((g, i) =>
        g.list ? (
          <ul key={i} dir={g.items[0]!.dir} className="ev-list">
            {g.items.map((p, j) => (
              <ClaimParagraph key={j} p={p} ctx={ctx} />
            ))}
          </ul>
        ) : (
          <ClaimParagraph key={i} p={g.items[0]!} ctx={ctx} />
        ),
      )}
    </>
  );
}

function Block({ block, ctx }: { block: ContentBlockView; ctx: Ctx }) {
  if (block.status === 'rejected') {
    return (
      <p className="ev-note ev-note--danger" role="note">
        <FileWarning size={16} aria-hidden="true" />
        <span>حُذف هذا الجزء لأنه لم يجتز التحقق من الأدلة.</span>
      </p>
    );
  }
  const label = BLOCK_LABELS_AR[block.kind];
  const body =
    block.kind === 'comparison_table' && block.table ? (
      <div className="ev-table-wrap">
        <table className="ev-table">
          <thead>
            <tr>
              {block.table.header.map((h, i) => (
                <th key={i} scope="col">
                  <RichBlock rt={h} ctx={ctx} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.table.rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c}>
                    <RichBlock rt={cell} ctx={ctx} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <RichBlock rt={block.content} ctx={ctx} />
    );
  const incomplete = block.status === 'incomplete' && (
    <p className="ev-note ev-note--warning" role="note">
      <CircleAlert size={16} aria-hidden="true" />
      <span>هذا الجزء غير مكتمل؛ لم تُعالج كل مصادره بعد.</span>
    </p>
  );
  if (!label) {
    return (
      <div className={`ev-block ev-block--${block.kind}`} data-block={block.block_key}>
        {body}
        {incomplete}
      </div>
    );
  }
  return (
    <section className={`ev-block ev-block--aside ev-block--${block.kind}`} data-block={block.block_key} aria-label={label}>
      <p className="ev-block__label" aria-hidden="true">
        {label}
      </p>
      {body}
      {incomplete}
    </section>
  );
}

function describeSuggested(s: SourceScope): string {
  const refs = s.reference_source_ids.length;
  return `${SCOPE_MODE_LABELS_AR[s.mode]}${refs ? ` (${refs === 1 ? 'مرجع واحد' : refs === 2 ? 'مرجعان' : `${refs} مراجع`})` : ''}`;
}

export interface ArtifactContentProps {
  artifact: ArtifactView;
  /** explicit owner action for an abstention that suggests a wider scope */
  onWidenScope?: (scope: SourceScope) => void;
  /** show the Evidence Ribbon (default true) */
  showRibbon?: boolean;
  className?: string;
}

export function ArtifactContent({ artifact: a, onWidenScope, showRibbon = true, className }: ArtifactContentProps) {
  const [inspect, setInspect] = useState<{ e: EvidenceView; claim: ClaimView } | null>(null);
  const ctx = useMemo<Ctx>(
    () => ({ claims: a.claims, pinned: new Set(a.is_frozen ? a.scope.version_ids : []), onInspect: (e, claim) => setInspect({ e, claim }) }),
    [a.claims, a.is_frozen, a.scope.version_ids],
  );
  const ribbon = useMemo(() => ribbonFromClaims(a.claims), [a.claims]);
  const status = ARTIFACT_STATUS[a.status];
  const titleId = `ev-artifact-${a.id}`;
  const blocks = [...a.blocks].sort((x, y) => x.ord - y.ord);

  return (
    <article className={['ev-artifact', className].filter(Boolean).join(' ')} aria-labelledby={a.title ? titleId : undefined} data-artifact={a.id}>
      <header className="ev-artifact__head">
        {a.title && (
          <h2 id={titleId} className="ev-artifact__title">
            {a.title}
          </h2>
        )}
        <div className="ev-artifact__meta">
          <StatusPill tone="neutral" icon={<Sparkles size={14} />}>
            محتوى مولَّد من مصادرك
          </StatusPill>
          <ScopeBadge scope={{ mode: a.scope.mode, describe_ar: a.scope.describe_ar, source_ids: a.scope.source_ids }} />
          {a.is_frozen && (
            <StatusPill tone="neutral" icon={<Lock size={14} />}>
              مثبّت على نسخته
            </StatusPill>
          )}
          {status && <StatusPill tone={status.tone}>{status.label}</StatusPill>}
        </div>
        {a.status === 'stale' && a.stale_reason && <p className="ev-note ev-note--warning">{a.stale_reason}</p>}
      </header>

      {a.abstain && (
        <section className="ev-abstain" role="status" aria-label="لم تُكتب إجابة">
          <CircleAlert size={20} aria-hidden="true" className="ev-abstain__icon" />
          <div className="ev-abstain__body">
            <p className="ev-abstain__reason">{a.abstain.reason_ar}</p>
            {a.abstain.detail && <p className="ev-abstain__detail">{a.abstain.detail}</p>}
            {a.abstain.suggest_scope && (
              <div className="ev-abstain__widen">
                <p>{`يمكن البحث في نطاق أوسع: ${describeSuggested(a.abstain.suggest_scope)}. لا يتغير النطاق إلا إذا اخترت ذلك.`}</p>
                <Button variant="secondary" size="sm" onClick={() => onWidenScope?.(a.abstain!.suggest_scope!)} disabled={!onWidenScope}>
                  وسّع النطاق
                </Button>
                {!onWidenScope && <p className="ev-note">توسيع النطاق متاح من لوحة الدراسة.</p>}
              </div>
            )}
          </div>
        </section>
      )}

      {blocks.length > 0 && (
        <div className="ev-artifact__body">
          {blocks.map((b) => (
            <Block key={b.id} block={b} ctx={ctx} />
          ))}
        </div>
      )}

      {a.coverage?.missing_ar && a.coverage.missing_ar.length > 0 && (
        <section className="ev-coverage" aria-label="ما لم يُغطَّ">
          <p className="ev-block__label">لم يُغطِّ هذا المحتوى:</p>
          <ul>
            {a.coverage.missing_ar.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </section>
      )}

      {a.removed.length > 0 && (
        <details className="ev-removed">
          <summary>{`جمل حُذفت لأنها لم تجتز التحقق (${a.removed.length})`}</summary>
          <ul>
            {a.removed.map((r, i) => (
              <li key={i}>
                <BidiText as="span" className="ev-removed__text" text={r.text} />
                <span className="ev-removed__reason">{r.reason_ar}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {showRibbon && blocks.length > 0 && <EvidenceRibbon items={ribbon} />}

      <SourceInspector
        open={!!inspect}
        evidence={inspect?.e ?? null}
        context={inspect ? { support_type: inspect.claim.support_type, verification_status: inspect.claim.verification_status } : undefined}
        onClose={() => setInspect(null)}
      />
    </article>
  );
}
