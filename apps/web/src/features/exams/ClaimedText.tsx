// RichText of a generated explanation / improved answer with the evidence chips of each claim right after it
// (C1 CitationChip → Evidence Peek → Source Inspector). Claims that are not linked are marked in words + icon,
// never by colour alone; a run without a claim is plain connective text. Source-question explanations without
// claims render as plain RichText.
import { Fragment, type ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import type { ClaimView, Paragraph, RichText, Run } from '@medlevo/shared';
import { StatusPill } from '../../design';
import { CLAIM_MARK_LABELS_AR, CitationChip, claimMark, segmentByClaim } from '../evidence';

const SAFE_MARKS = new Set(['b', 'i', 'u', 'sup', 'sub', 'em']);

function RunNode({ run, paraDir }: { run: Run; paraDir: 'rtl' | 'ltr' }) {
  const dir = run.dir ?? paraDir;
  let content: ReactNode = run.t;
  for (const m of [...(run.marks ?? [])].reverse()) {
    if (!SAFE_MARKS.has(m)) continue;
    const Tag = m as 'b';
    content = <Tag>{content}</Tag>;
  }
  if (dir !== paraDir) {
    return (
      <bdi dir={dir} lang={run.lang ?? (dir === 'ltr' ? 'en' : 'ar')} className={dir === 'ltr' ? 'ml-ltr' : 'ml-rtl-island'}>
        {content}
      </bdi>
    );
  }
  return <>{content}</>;
}

/** The evidence chips of one claim (+ a worded mark when it is not linked). */
export function ClaimChips({ claim }: { claim: ClaimView | undefined }) {
  const mark = claimMark(claim);
  return (
    <span className="ex-claim__trail">
      {claim?.citations.map((c) => (
        <CitationChip key={`${c.evidence.id}-${c.relation}`} evidence={c.evidence} context={{ support_type: claim.support_type, verification_status: claim.verification_status, relation: c.relation }} />
      ))}
      {mark !== 'linked' && (
        <StatusPill tone={mark === 'conflict' || mark === 'rejected' ? 'danger' : 'warning'} icon={<CircleAlert size={14} />} title={claim?.issues.map((x) => x.reason_ar).join(' ') || undefined}>
          {CLAIM_MARK_LABELS_AR[mark]}
        </StatusPill>
      )}
    </span>
  );
}

function ClaimParagraph({ p, claims }: { p: Paragraph; claims: Record<string, ClaimView> }) {
  return (
    <p dir={p.dir} lang={p.dir === 'rtl' ? 'ar' : 'en'} className="ex-claimed__p">
      {segmentByClaim(p).map((s, i) => {
        const runs = s.runs.map((r, j) => <RunNode key={j} run={r} paraDir={p.dir} />);
        if (!s.claimId) return <Fragment key={i}>{runs}</Fragment>;
        const claim = claims[s.claimId];
        return (
          <Fragment key={i}>
            <span className={`ex-claim ex-claim--${claimMark(claim)}`}>{runs}</span>
            <ClaimChips claim={claim} />
          </Fragment>
        );
      })}
    </p>
  );
}

export function ClaimedText({ value, claims, className }: { value: RichText | null | undefined; claims: Record<string, ClaimView>; className?: string }) {
  if (!value || value.paragraphs.length === 0) return null;
  return (
    <div className={className ? `ex-claimed ${className}` : 'ex-claimed'}>
      {value.paragraphs.map((p, i) => (
        <ClaimParagraph key={i} p={p} claims={claims} />
      ))}
    </div>
  );
}
