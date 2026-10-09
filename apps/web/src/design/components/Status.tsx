import type { ReactNode } from 'react';
import { CircleAlert, CircleCheck, CloudCheck, CloudUpload, GitCompare, HardDrive, Info, TriangleAlert, FileText, CloudOff } from 'lucide-react';
import { SYNC_STATE_LABELS_AR, type SyncState } from '@medlevo/shared';
import { cx } from '../utils';
import { Tooltip } from './Tooltip';

export type StatusTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

const DEFAULT_ICON: Record<StatusTone, ReactNode> = {
  neutral: <Info size={14} />,
  accent: <Info size={14} />,
  success: <CircleCheck size={14} />,
  warning: <TriangleAlert size={14} />,
  danger: <CircleAlert size={14} />,
  info: <Info size={14} />,
};

/** Status label: icon + text, never colour alone. */
export function StatusPill({ tone = 'neutral', icon, children, className, title }: { tone?: StatusTone; icon?: ReactNode | false; children: ReactNode; className?: string; title?: string }) {
  return (
    <span className={cx('ml-pill', `ml-pill--${tone}`, className)} title={title}>
      {icon !== false && (
        <span className="ml-pill__icon" aria-hidden="true">
          {icon ?? DEFAULT_ICON[tone]}
        </span>
      )}
      <span>{children}</span>
    </span>
  );
}

export interface SourceChipProps {
  /** Short source label, e.g. «محاضرة» or the source title. */
  label: string;
  /** Printed page label as it appears in the source (e.g. "12"). */
  page?: string;
  /** 0-based page index in the file; shown when it differs from the printed label (§07, AC-04). */
  pageIndex?: number;
  /** Full source title for the accessible name / tooltip. */
  sourceTitle?: string;
  /** false when the cited page is not downloaded for offline use (§47). */
  available?: boolean;
  unavailableReason?: string;
  onOpen: () => void;
  className?: string;
}

/**
 * Citation chip, e.g. «محاضرة ص12». A real button: Enter/Space open the source at the cited page.
 * Shows both numberings when the printed page differs from the file position.
 */
export function SourceChip({ label, page, pageIndex, sourceTitle, available = true, unavailableReason = 'هذه الصفحة غير محمّلة على هذا الجهاز', onOpen, className }: SourceChipProps) {
  const filePage = typeof pageIndex === 'number' ? pageIndex + 1 : undefined;
  const differs = page != null && filePage != null && String(filePage) !== page;
  const visible = page != null ? `${label} ص${page}` : label;
  const detail = [
    sourceTitle,
    page != null ? `ص ${page}${differs ? ` (الصفحة ${filePage} في الملف)` : ''}` : filePage != null ? `الصفحة ${filePage} في الملف` : undefined,
    !available ? unavailableReason : undefined,
  ]
    .filter(Boolean)
    .join(' — ');
  return (
    <Tooltip content={detail || visible} describe={false}>
      <button
        type="button"
        className={cx('ml-source-chip', !available && 'ml-source-chip--unavailable', className)}
        aria-label={`فتح المصدر: ${detail || visible}`}
        onClick={onOpen}
        data-available={available ? 'true' : 'false'}
      >
        <span className="ml-source-chip__icon" aria-hidden="true">
          {available ? <FileText size={14} /> : <CloudOff size={14} />}
        </span>
        <span className="ml-source-chip__label">{visible}</span>
      </button>
    </Tooltip>
  );
}

const SAVE_ICON: Record<SyncState, ReactNode> = {
  saved_locally: <HardDrive size={16} />,
  pending_sync: <CloudUpload size={16} />,
  synced: <CloudCheck size={16} />,
  conflict: <GitCompare size={16} />,
  error: <CircleAlert size={16} />,
};

const SAVE_TONE: Record<SyncState, StatusTone> = {
  saved_locally: 'neutral',
  pending_sync: 'info',
  synced: 'success',
  conflict: 'warning',
  error: 'danger',
};

export interface SaveStatusProps {
  state: SyncState;
  /** Extra explanation (e.g. «3 تغييرات ستُرسل عند عودة الاتصال»). Shown as tooltip and announced. */
  detail?: string;
  /** Hide the text on very narrow layouts (still announced; icon + tooltip remain). Avoid when possible. */
  compact?: boolean;
  className?: string;
  /** Announce changes politely (only one live SaveStatus per screen). */
  live?: boolean;
  onClick?: () => void;
}

/**
 * Honest save indicator (§26, §47): محفوظ محليًا / ينتظر المزامنة / تمت المزامنة / تعارض / خطأ.
 * Icon + text, never colour only. Never claims "synced" before the server confirmed it.
 */
/** Icon + label of a save state (for custom triggers, e.g. the shell's sync button). */
export function SaveStatusContent({ state, compact, detail }: { state: SyncState; compact?: boolean; detail?: string }) {
  return (
    <>
      <span className="ml-save-status__icon" aria-hidden="true">
        {SAVE_ICON[state]}
      </span>
      <span className={compact ? 'ml-visually-hidden' : 'ml-save-status__text'}>{SYNC_STATE_LABELS_AR[state]}</span>
      {detail && <span className="ml-visually-hidden">{`: ${detail}`}</span>}
    </>
  );
}

export function saveStatusClass(state: SyncState, extra?: string): string {
  return cx('ml-save-status', `ml-save-status--${SAVE_TONE[state]}`, extra);
}

export function SaveStatus({ state, detail, compact, className, live = false, onClick }: SaveStatusProps) {
  const content = <SaveStatusContent state={state} compact={compact} detail={detail} />;
  const cls = saveStatusClass(state, cx(onClick && 'ml-save-status--button', className));
  const node = onClick ? (
    <button type="button" className={cls} data-state={state} onClick={onClick} aria-live={live ? 'polite' : undefined}>
      {content}
    </button>
  ) : (
    <span className={cls} data-state={state} role={live ? 'status' : undefined} aria-live={live ? 'polite' : undefined} tabIndex={detail ? 0 : undefined}>
      {content}
    </span>
  );
  return detail ? (
    <Tooltip content={detail} describe={false}>
      {node}
    </Tooltip>
  ) : (
    node
  );
}
