// Citation chip + Evidence Peek (§11). The chip is the design SourceChip («محاضرة ص12»); a click, Enter /
// Space or a touch long-press opens the peek — never hover-only. The peek shows the exact quote, the source
// (name, type, version), the page label (printed + file page when they differ), the support type, precise
// extraction / verification statuses (STATUS_LABELS_AR — never «AI Verified») and availability, with
// «افتح المصدر» (Source Jump inside the workspace, the reader URL elsewhere). An unavailable page is said to
// be unavailable — no substitute page is ever opened.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { CircleAlert, FileSearch, ScanSearch } from 'lucide-react';
import type { ClaimView, EvidenceView } from '@medlevo/shared';
import { Button, SourceChip, StatusPill, type StatusTone } from '../../design';
import { AnchoredPanel } from './AnchoredPanel';
import { BidiText } from './BidiText';
import { availabilityReason, canOpen, chipText, extractionLabel, sourceTypeLabel, supportLabel, verificationLabel } from './model';
import { useEffectiveAvailability, useOpenSource } from './useOpenSource';

export interface CitationContext {
  support_type?: ClaimView['support_type'];
  verification_status?: ClaimView['verification_status'];
  relation?: ClaimView['citations'][number]['relation'];
}

const EXTRACTION_TONE: Record<EvidenceView['extraction_status'], StatusTone> = {
  extracted: 'neutral',
  checks_passed: 'success',
  owner_reviewed: 'success',
  needs_review: 'warning',
  uncertain: 'warning',
  rejected: 'danger',
};
const VERIFICATION_TONE: Record<ClaimView['verification_status'], StatusTone> = {
  linked: 'success',
  owner_reviewed: 'success',
  needs_review: 'warning',
  conflict: 'danger',
  rejected: 'danger',
  pending: 'info',
};
const RELATION_AR: Record<NonNullable<CitationContext['relation']>, string> = {
  supports: 'يدعم الجملة',
  partially_supports: 'يدعم جزءًا من الجملة',
  contradicts: 'يناقض الجملة',
  context: 'سياق فقط',
};

export interface EvidencePeekProps {
  evidence: EvidenceView;
  context?: CitationContext;
  /** opens the larger Source Inspector (optional) */
  onInspect?: () => void;
  /** called after a successful «افتح المصدر» */
  onOpened?: () => void;
  headingId?: string;
}

/** The peek's content (also usable on its own, e.g. inside a list). */
export function EvidencePeek({ evidence: e, context, onInspect, onOpened, headingId }: EvidencePeekProps) {
  const openSource = useOpenSource();
  const availability = useEffectiveAvailability(e) ?? e.availability;
  const reason = availabilityReason(availability, e.version_no);
  const [openError, setOpenError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const autoId = useId();
  const titleId = headingId ?? `ev-peek-${autoId}`;

  const onOpen = async () => {
    setOpenError(null);
    setBusy(true);
    try {
      const r = await openSource(e);
      if (r.ok) onOpened?.();
      else setOpenError(r.reason_ar);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ev-peek" data-availability={availability}>
      <header className="ev-peek__head">
        <h2 id={titleId} className="ev-peek__title">
          <BidiText as="span" dir="rtl" text={e.source_title || 'مصدر بلا عنوان'} />
        </h2>
        <p className="ev-peek__meta">
          <span>{sourceTypeLabel(e.source_type)}</span>
          <span>{`النسخة ${e.version_no}`}</span>
          <span className="ev-peek__locator">{e.locator_label_ar}</span>
        </p>
      </header>
      <BidiText as="blockquote" className="ev-quote" text={e.quote} />
      <dl className="ev-facts">
        {context?.support_type && (
          <div className="ev-facts__row">
            <dt>نوع الاستناد</dt>
            <dd>{supportLabel(context.support_type)}</dd>
          </div>
        )}
        {context?.relation && (
          <div className="ev-facts__row">
            <dt>علاقة الدليل بالجملة</dt>
            <dd>{RELATION_AR[context.relation]}</dd>
          </div>
        )}
        <div className="ev-facts__row">
          <dt>حالة الاستخراج</dt>
          <dd>
            <StatusPill tone={EXTRACTION_TONE[e.extraction_status]}>{extractionLabel(e.extraction_status)}</StatusPill>
          </dd>
        </div>
        {context?.verification_status && (
          <div className="ev-facts__row">
            <dt>حالة التحقق</dt>
            <dd>
              <StatusPill tone={VERIFICATION_TONE[context.verification_status]}>{verificationLabel(context.verification_status)}</StatusPill>
            </dd>
          </div>
        )}
      </dl>
      {reason && (
        <p className="ev-note ev-note--warning" role="note">
          <CircleAlert size={16} aria-hidden="true" />
          <span>{reason}</span>
        </p>
      )}
      {openError && (
        <p className="ev-note ev-note--danger" role="alert">
          <CircleAlert size={16} aria-hidden="true" />
          <span>{openError}</span>
        </p>
      )}
      <div className="ev-peek__actions">
        <Button variant="primary" size="sm" icon={<FileSearch size={16} />} onClick={onOpen} disabled={!canOpen(availability)} loading={busy}>
          افتح المصدر
        </Button>
        {onInspect && (
          <Button variant="secondary" size="sm" icon={<ScanSearch size={16} />} onClick={onInspect} disabled={availability === 'source_deleted'}>
            فحص الموضع في الصفحة
          </Button>
        )}
      </div>
    </div>
  );
}

export interface CitationChipProps {
  evidence: EvidenceView;
  context?: CitationContext;
  /** shows «فحص الموضع في الصفحة» in the peek */
  onInspect?: (e: EvidenceView) => void;
  className?: string;
}

const LONG_PRESS_MS = 500;

/** «محاضرة ص12» chip that opens the Evidence Peek. */
export function CitationChip({ evidence, context, onInspect, className }: CitationChipProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const press = useRef<{ timer: ReturnType<typeof setTimeout> | null; fired: boolean }>({ timer: null, fired: false });
  const panelId = useId();
  const availability = useEffectiveAvailability(evidence) ?? evidence.availability;

  const button = () => anchorRef.current?.querySelector('button') ?? null;
  const close = useCallback(({ returnFocus }: { returnFocus: boolean }) => {
    setOpen(false);
    if (returnFocus) button()?.focus();
  }, []);

  // ARIA for the design chip (a button that opens a dialog)
  useEffect(() => {
    const b = button();
    if (!b) return;
    b.setAttribute('aria-haspopup', 'dialog');
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) b.setAttribute('aria-controls', panelId);
    else b.removeAttribute('aria-controls');
  }, [open, panelId]);

  const clearPress = () => {
    if (press.current.timer) clearTimeout(press.current.timer);
    press.current.timer = null;
  };

  return (
    <span
      ref={anchorRef}
      className={['ev-chip', className].filter(Boolean).join(' ')}
      data-evidence-id={evidence.id}
      onPointerDown={(e) => {
        if (e.pointerType !== 'touch') return;
        press.current.fired = false;
        clearPress();
        press.current.timer = setTimeout(() => {
          press.current.fired = true;
          setOpen(true);
        }, LONG_PRESS_MS);
      }}
      onPointerUp={clearPress}
      onPointerCancel={clearPress}
      onPointerLeave={clearPress}
      onContextMenu={(e) => {
        // a long-press must not open the system menu over the chip
        if (press.current.fired) e.preventDefault();
      }}
    >
      <SourceChip
        label={chipText(evidence)}
        // accessible name / tooltip: the visible chip text first (label-in-name), then the source and both numberings
        sourceTitle={`${chipText(evidence)} — ${evidence.source_title} — ${evidence.locator_label_ar}`}
        available={canOpen(availability)}
        unavailableReason={availabilityReason(availability, evidence.version_no) ?? undefined}
        onOpen={() => {
          if (press.current.fired) {
            press.current.fired = false;
            return; // the long-press already opened it
          }
          setOpen((v) => !v);
        }}
      />
      <AnchoredPanel open={open} anchorRef={anchorRef} onClose={close} label={`الدليل: ${chipText(evidence)}`} id={panelId}>
        <EvidencePeek
          evidence={evidence}
          context={context}
          onInspect={
            onInspect
              ? () => {
                  setOpen(false); // the inspector takes over (no peek left behind its scrim)
                  onInspect(evidence);
                }
              : undefined
          }
          onOpened={() => setOpen(false)}
        />
      </AnchoredPanel>
    </span>
  );
}
