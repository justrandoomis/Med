// Public server API of the evidence module for other tracks (Study Book, Questions, Exams, …).
// Import from here: `import { resolveScope, retrieve, packFromCandidates, validateClaims } from '../evidence/services';`
// Contract and examples: docs/modules/evidence-search.md.
export { resolveScope, toResolvedScope, inScope, describeScopeAr, externalEvidenceEnabled, type ScopeReport } from './scope';
export {
  retrieve,
  abstainFor,
  suggestWiderScope,
  searchedReport,
  priorityTiers,
  pagesAr,
  RETRIEVAL_PURPOSES,
  type RetrievalPurpose,
  type RetrieveRequest,
  type RetrieveResult,
  type RetrievalCandidate,
  type RetrievalAnchor,
  type AbstainDecision,
} from './retrieval';
export { fromRegion, fromChunk, getView, getViews, getViewsWithMissing, locatorLabelAr, type EvidenceRow } from './evidence';
export { buildEvidencePack, packFromCandidates, evidenceFromCandidates, type AliasMap, type EvidencePack } from './pack';
export {
  validateClaims,
  getClaimView,
  getClaimViews,
  claimIdsForOwner,
  ribbonFor,
  VERIFIER_VERSION,
  type ValidateClaimsInput,
  type ValidateClaimsResult,
  type SentenceResult,
  type CheckOutcome,
} from './claims';
export { checkCriticalTokens, checkContainment, extractCriticalTokens, type CriticalTokens, type CriticalCheckResult } from './critical';
export {
  recordDependencies,
  onSourceVersionChanged,
  reconcileAlerts,
  compareVersions,
  listAlerts,
  getAlert,
  setAlertStatus,
  DEPENDENT_TYPES,
  type VersionChangeInput,
} from './dependencies';
export { buildQuery, type BuiltQuery, type Expansion } from './terms';
export { cacheKey, canReuse, type CacheKeyInput, type ReuseCheck } from './cache';
export { hasPseudoCitation, inventedCitations, pseudoCitations, stripPseudoCitations } from './textcite';
