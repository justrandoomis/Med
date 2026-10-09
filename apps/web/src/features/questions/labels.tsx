// Shared presentational bits of the Question Vault: status pills (text + icon, never colour alone), the
// question stem with emphasized negation, and the origin line.
import { Fragment } from 'react';
import { CircleCheck, FileQuestion, Flag, Link2, ScanText, Sparkles, UserPen } from 'lucide-react';
import { detectDir, segmentRuns, type AnswerStatus, type ExtractionStatus, type LectureLinkRelation, type QuestionStatus, type QuestionView, type RichText } from '@medlevo/shared';
import { Bidi, RichTextView, StatusPill } from '../../design';
import { answerPill, extractionPill, relationPill, statusPill } from './model';

export function AnswerPill({ status }: { status: AnswerStatus }) {
  const p = answerPill(status);
  return (
    <StatusPill tone={p.tone} title="حالة مفتاح الإجابة">
      <span className="ml-visually-hidden">المفتاح: </span>
      {p.label}
    </StatusPill>
  );
}

export function ExtractionPill({ status }: { status: ExtractionStatus }) {
  const p = extractionPill(status);
  return (
    <StatusPill tone={p.tone} icon={<ScanText size={14} />} title="حالة استخراج النص">
      <span className="ml-visually-hidden">الاستخراج: </span>
      {p.label}
    </StatusPill>
  );
}

export function QuestionStatusPill({ status }: { status: QuestionStatus }) {
  const p = statusPill(status);
  return (
    <StatusPill tone={p.tone} icon={status === 'ready' ? <CircleCheck size={14} /> : undefined} title="حالة السؤال">
      {p.label}
    </StatusPill>
  );
}

export function RelationPill({ relation }: { relation: LectureLinkRelation }) {
  const p = relationPill(relation);
  return (
    <StatusPill tone={p.tone} icon={<Link2 size={14} />} title="علاقة السؤال بالمحاضرة">
      {p.label}
    </StatusPill>
  );
}

export function ReviewPill({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <StatusPill tone="warning" icon={<Flag size={14} />}>
      {count === 1 ? 'عنصر مراجعة مفتوح' : `${count} عناصر مراجعة مفتوحة`}
    </StatusPill>
  );
}

export function NegationPill({ terms }: { terms: string[] }) {
  if (terms.length === 0) return null;
  return (
    <StatusPill tone="info" icon={false} title="صيغة نفي محفوظة كما في الأصل">
      نفي: <Bidi dir="ltr">{terms.join('، ')}</Bidi>
    </StatusPill>
  );
}

export function OriginIcon({ origin }: { origin: QuestionView['origin_type'] }) {
  if (origin === 'generated') return <Sparkles size={16} aria-hidden="true" />;
  if (origin === 'owner') return <UserPen size={16} aria-hidden="true" />;
  return <FileQuestion size={16} aria-hidden="true" />;
}

/** The stem as stored (RichText): negation runs carry em+b marks and render emphasized. */
export function Stem({ value, className }: { value: RichText; className?: string }) {
  return <RichTextView value={value} className={className ? `qv-stem ${className}` : 'qv-stem'} />;
}

/**
 * A server-built string that mixes Arabic and English (origin labels «… — Surgery Course 1 — ص 1–2 — …», link
 * reasons, key lines): its base direction comes from its strong characters and every opposite-direction island
 * («Surgery Course 1», «1–2», «Alvarado score») is isolated, so ranges and names never reorder (§21).
 */
export function MixedText({ text, className }: { text: string; className?: string }) {
  const dir = detectDir(text);
  const runs = segmentRuns(text, dir);
  return (
    <bdi dir={dir} lang={dir === 'ltr' ? 'en' : 'ar'} className={className}>
      {runs.map((r, i) =>
        r.dir && r.dir !== dir ? (
          <bdi key={i} dir={r.dir} lang={r.dir === 'ltr' ? 'en' : 'ar'}>
            {r.t}
          </bdi>
        ) : (
          <Fragment key={i}>{r.t}</Fragment>
        ),
      )}
    </bdi>
  );
}
