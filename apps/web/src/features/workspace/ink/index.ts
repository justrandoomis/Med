export { InkProvider, useInk } from './InkProvider';
export { InkLayer } from './InkLayer';
export { InkToolbar } from './InkToolbar';
export type * from './types';
// Additional exports (additive; the contract above is unchanged):
// the single applier for pulled/pushed `annotation` entities (all kinds), for screens that need
// annotations synced before an InkProvider mounts; and the live pen capability report (§27, AC-28).
export { registerAnnotationApplier } from './persistence';
export { onAnnotationRowsChanged } from './events';
export { CapabilityPanel, CapabilityDialog } from './CapabilityPanel';
