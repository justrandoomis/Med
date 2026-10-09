// Evidence UI for other tracks (Study Book, Questions, Exams, workspace rail). See docs/modules/evidence-search.md.
import './evidence.css';

export { CitationChip, EvidencePeek, type CitationChipProps, type EvidencePeekProps, type CitationContext } from './CitationChip';
export { SourceInspector, InspectButton, type SourceInspectorProps } from './SourceInspector';
export { EvidenceRibbon, RIBBON_NOTE_AR, type EvidenceRibbonProps } from './EvidenceRibbon';
export { ArtifactContent, type ArtifactContentProps } from './ArtifactContent';
export { ScopeBadge, ScopePicker, type ScopeBadgeProps, type ScopePickerProps, type ScopeCandidate } from './Scope';
export { ContentAlertsPanel, AlertCard, type ContentAlertsPanelProps } from './ContentAlertsPanel';
export { BidiText, BidiLines, type BidiTextProps } from './BidiText';
export { useOpenSource, useEffectiveAvailability, type OpenResult } from './useOpenSource';
export * as evidenceApi from './api';
export {
  chipText,
  availabilityReason,
  canOpen,
  claimMark,
  ribbonFromClaims,
  segmentByClaim,
  linkedSentencesAr,
  sentencesAr,
  sourcesCountAr,
  CLAIM_MARK_LABELS_AR,
  type ClaimMark,
} from './model';
