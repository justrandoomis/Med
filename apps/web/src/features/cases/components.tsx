// Small building blocks shared by the case screens: evidence-linked sentences (chips right after each claim; anything
// not linked is marked in words + icon, never by colour alone), the appropriateness pill, the «authored data» label
// and the honesty notes (what the simulation can / cannot assess).
import { CircleAlert, CircleCheck, CircleX, Info, NotebookPen } from 'lucide-react';
import {
  CASE_SENTENCE_STATUS_LABELS_AR,
  DECISION_APPROPRIATENESS_LABELS_AR,
  AUTHORED_DATA_LABEL_AR,
  type CaseHonesty,
  type CaseSentence,
  type ClaimView,
  type DecisionAppropriateness,
} from '@medlevo/shared';
import { StatusPill, type StatusTone } from '../../design';
import { BidiText, CitationChip } from '../evidence';

const SENTENCE_TONE: Record<CaseSentence['status'], StatusTone> = {
  linked: 'success',
  needs_review: 'warning',
  conflict: 'danger',
  rejected: 'danger',
  no_evidence: 'warning',
  not_medical: 'neutral',
};

/** A list of explanation sentences with their evidence chips. */
export function CaseSentences({ sentences, claims, className }: { sentences: CaseSentence[]; claims: Record<string, ClaimView>; className?: string }) {
  if (sentences.length === 0) return null;
  return (
    <div className={className ? `cs-sentences ${className}` : 'cs-sentences'}>
      {sentences.map((s, i) => {
        const claim = s.claim_id ? claims[s.claim_id] : undefined;
        return (
          <p key={i} className={`cs-sentence cs-sentence--${s.status}`}>
            <BidiText as="span" text={s.text} />{' '}
            {claim?.citations.map((c) => (
              <CitationChip key={`${c.evidence.id}-${c.relation}`} evidence={c.evidence} context={{ support_type: claim.support_type, verification_status: claim.verification_status, relation: c.relation }} />
            ))}
            {s.status !== 'linked' && s.status !== 'not_medical' && (
              <StatusPill tone={SENTENCE_TONE[s.status]} icon={<CircleAlert size={14} />} title={s.reason_ar ?? undefined}>
                {CASE_SENTENCE_STATUS_LABELS_AR[s.status]}
              </StatusPill>
            )}
            {s.reason_ar && s.status !== 'linked' && s.status !== 'not_medical' && <span className="cs-sentence__why">{s.reason_ar}</span>}
          </p>
        );
      })}
    </div>
  );
}

const APPROPRIATE_TONE: Record<DecisionAppropriateness, StatusTone> = { appropriate: 'success', acceptable: 'warning', inappropriate: 'danger' };
const APPROPRIATE_ICON: Record<DecisionAppropriateness, typeof CircleCheck> = { appropriate: CircleCheck, acceptable: Info, inappropriate: CircleX };

export function AppropriatenessPill({ value }: { value: DecisionAppropriateness }) {
  const Icon = APPROPRIATE_ICON[value];
  return (
    <StatusPill tone={APPROPRIATE_TONE[value]} icon={<Icon size={14} />}>
      {DECISION_APPROPRIATENESS_LABELS_AR[value]}
    </StatusPill>
  );
}

/** «بيانات تعليمية مؤلفة» — always next to patient / scenario details. */
export function AuthoredLabel({ note }: { note?: string }) {
  return (
    <span className="cs-authored" title={note}>
      <NotebookPen size={14} aria-hidden="true" />
      {AUTHORED_DATA_LABEL_AR}
    </span>
  );
}

export function HonestyNotes({ honesty, open = false }: { honesty: CaseHonesty; open?: boolean }) {
  return (
    <details className="cs-honesty" open={open}>
      <summary>ما تقيّمه هذه المحاكاة وما لا تستطيع تقييمه</summary>
      <div className="cs-honesty__cols">
        <div>
          <h3 className="cs-honesty__h">تقيّم</h3>
          <ul>
            {honesty.can_assess_ar.map((t) => (
              <li key={t}>
                <BidiText as="span" text={t} />
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="cs-honesty__h">لا تقيّم</h3>
          <ul>
            {honesty.cannot_assess_ar.map((t) => (
              <li key={t}>
                <BidiText as="span" text={t} />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </details>
  );
}
