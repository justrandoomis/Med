// The thread of a study chat, Claude-style: the owner's messages as bubbles at the inline-end, the assistant's answers
// full-width without a bubble. A «صفحة N» divider opens each page section (turns are filed under the page they are
// about). An answer is ONLY ever the evidence-checked result (ArtifactContent: citation chips → Evidence Peek); while it
// is written the unverified draft streams labelled «مسودة لم تُتحقق بعد», and after it the sentences verification
// removed are listed as removed. Under an answer: «ص 3» chips that move the reader to that page, copy, regenerate
// (last answer), save as note; under the last question: edit.
import type { ReactNode } from 'react';
import { Copy, NotebookPen, Pencil, RefreshCw } from 'lucide-react';
import { CHAT_MODEL_INFO, type ChatMessageView, type SourceScope } from '@medlevo/shared';
import { Button, IconButton, StatusPill } from '../../../design';
import { ArtifactContent } from '../../evidence';
import { DraftOutcome, StreamDraft, type StreamView } from '../streaming';
import { Markdown } from './Markdown';
import { pageChipLabel, pageDividers, plainOf, type Turn } from './model';

export interface PendingTurn {
  text: string;
  pageIndex: number | null;
  stream: StreamView;
}

export interface ChatTurnsProps {
  turns: Turn[];
  pending: PendingTurn | null;
  /** removed-from-draft report per answer id (after streaming) */
  outcomes: Record<string, { hadDraft: boolean; removed: Array<{ text: string; reason_ar: string }> }>;
  saved: Record<string, boolean>;
  pageLabel?: (pageIndex: number) => string | null;
  onJump?: (pageIndex: number) => void;
  onCopy: (m: ChatMessageView) => void;
  onRegenerate?: (t: Turn) => void;
  onEdit?: (t: Turn) => void;
  onSaveNote: (m: ChatMessageView) => void;
  onWidenScope?: (wider: SourceScope, t: Turn) => void;
  onStop: () => void;
  busy: boolean;
}

const PENDING_LABEL: Partial<Record<ChatMessageView['status'], string>> = {
  draft: 'لم تكتمل هذه الإجابة بعد',
  verifying: 'يُتحقق من الإجابة جملةً جملة',
  rejected: 'لم تكتمل هذه الإجابة؛ لم يُعرض أي جزء منها',
};

/** the streamed draft blocks as markdown (headings / lists keep their shape while the answer is written) */
export function draftMarkdown(v: StreamView): string {
  return v.blocks
    .map((b) => (b.kind === 'heading' ? `### ${b.sentences.join(' ')}` : b.kind === 'list' ? b.sentences.map((x) => `- ${x}`).join('\n') : b.sentences.join(' ')))
    .join('\n\n');
}

function modelLabel(id: string | null | undefined): string | null {
  if (!id) return null;
  return (CHAT_MODEL_INFO as Record<string, { name: string }>)[id]?.name ?? null;
}

function Divider({ page, label, onJump }: { page: number; label: string; onJump?: (i: number) => void }) {
  return (
    <div className="ch-divider" role="separator" aria-label={`صفحة ${label}`}>
      {onJump ? (
        <button type="button" className="ch-divider__label" onClick={() => onJump(page)}>
          {`صفحة ${label}`}
        </button>
      ) : (
        <span className="ch-divider__label">{`صفحة ${label}`}</span>
      )}
    </div>
  );
}

function PageChips({ pages, label, onJump }: { pages: number[]; label?: (i: number) => string | null; onJump?: (i: number) => void }) {
  if (!pages.length || !onJump) return null;
  return (
    <ul className="ch-pages" aria-label="الصفحات التي يشرحها هذا الرد">
      {pages.map((i) => (
        <li key={i}>
          <button type="button" className="ch-page-chip" onClick={() => onJump(i)} aria-label={`اذهب إلى ${pageChipLabel(i, label).replace('ص', 'الصفحة')}`}>
            {pageChipLabel(i, label)}
          </button>
        </li>
      ))}
    </ul>
  );
}

function OwnerBubble({ text, actions }: { text: string; actions?: ReactNode }) {
  return (
    <div className="ch-msg ch-msg--owner">
      <span className="ml-visually-hidden">أنت: </span>
      <div className="ch-bubble">
        <Markdown text={text} />
      </div>
      {actions && <div className="ch-actions ch-actions--owner">{actions}</div>}
    </div>
  );
}

export function ChatTurns(p: ChatTurnsProps) {
  const dividers = pageDividers(p.turns);
  const labelOf = (i: number) => p.pageLabel?.(i) ?? String(i + 1);
  const last = p.turns[p.turns.length - 1];
  return (
    <>
      {p.turns.map((t) => {
        const div = dividers.get(t.id);
        const a = t.answer;
        const isLast = t === last && !p.pending;
        const settled = a && (a.status === 'final' || a.status === 'abstained');
        return (
          <article key={t.id} className="ch-turn" data-turn-id={t.id} data-page={t.primaryPage ?? undefined} aria-label={t.primaryPage !== null ? `سؤال وجواب — صفحة ${labelOf(t.primaryPage)}` : 'سؤال وجواب'}>
            {div !== undefined && <Divider page={div} label={labelOf(div)} onJump={p.onJump} />}
            <OwnerBubble
              text={plainOf(t.question)}
              actions={
                <>
                  <IconButton size="sm" variant="plain" label="انسخ السؤال" icon={<Copy size={14} />} onClick={() => p.onCopy(t.question)} />
                  {isLast && p.onEdit && <IconButton size="sm" variant="plain" label="عدّل السؤال" icon={<Pencil size={14} />} disabled={p.busy} onClick={() => p.onEdit!(t)} />}
                </>
              }
            />
            <div className="ch-msg ch-msg--assistant">
              <span className="ml-visually-hidden">MedLevo: </span>
              {a && p.outcomes[a.id] && <DraftOutcome hadDraft={p.outcomes[a.id]!.hadDraft} removed={p.outcomes[a.id]!.removed} />}
              {!a ? null : settled ? (
                a.artifact ? (
                  <ArtifactContent artifact={a.artifact} showRibbon={false} onWidenScope={p.onWidenScope ? (w) => p.onWidenScope!(w, t) : undefined} />
                ) : (
                  <Markdown text={plainOf(a)} />
                )
              ) : (
                <StatusPill tone={a.status === 'rejected' ? 'danger' : 'info'}>{a.error?.message ?? PENDING_LABEL[a.status] ?? a.status}</StatusPill>
              )}
              {a && (
                <div className="ch-actions">
                  <PageChips pages={a.status === 'final' ? (a.page_indexes ?? []) : []} label={p.pageLabel} onJump={p.onJump} />
                  {a.status === 'final' && <IconButton size="sm" variant="plain" label="انسخ الإجابة" icon={<Copy size={14} />} onClick={() => p.onCopy(a)} />}
                  {isLast && p.onRegenerate && <IconButton size="sm" variant="plain" label="أعد توليد الإجابة" icon={<RefreshCw size={14} />} disabled={p.busy} onClick={() => p.onRegenerate!(t)} />}
                  {a.status === 'final' && (
                    <Button size="sm" variant="plain" icon={<NotebookPen size={14} />} disabled={p.saved[a.id]} onClick={() => p.onSaveNote(a)}>
                      {p.saved[a.id] ? 'حُفظت في ملاحظاتي' : 'احفظ كملاحظة'}
                    </Button>
                  )}
                  {(modelLabel(a.model) || a.usage?.cost_usd != null) && (
                    <span className="ch-meta">
                      {[modelLabel(a.model), a.usage?.cost_usd != null ? `≈ ${a.usage.cost_usd.toFixed(4)}$ تقديريًا` : null].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </div>
              )}
            </div>
          </article>
        );
      })}
      {p.pending && (
        <article className="ch-turn ch-turn--pending" data-pending="true" aria-label="سؤالك قيد الإجابة">
          {p.pending.pageIndex !== null && last?.primaryPage !== p.pending.pageIndex && <Divider page={p.pending.pageIndex} label={labelOf(p.pending.pageIndex)} onJump={p.onJump} />}
          <OwnerBubble text={p.pending.text} />
          <div className="ch-msg ch-msg--assistant">
            <StreamDraft
              view={p.pending.stream}
              body={<Markdown text={draftMarkdown(p.pending.stream)} />}
              actions={
                <Button size="sm" variant="plain" onClick={p.onStop}>
                  أوقف
                </Button>
              }
            />
          </div>
        </article>
      )}
    </>
  );
}
